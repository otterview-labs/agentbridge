package com.otterview.agentsessionbridge;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebChromeClient;
import android.webkit.ConsoleMessage;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Locale;

public final class MainActivity extends Activity {
  private static final int REQUEST_VOICE = 41024;
  private static final int REQUEST_NOTIFICATIONS = 41025;
  private static final int RESULT_NOTIFICATION_ID = 41027;

  private WebView webView;
  private PhoneBridge bridge;
  private SpeechRecognizer recognizer;
  private TextToSpeech textToSpeech;
  private boolean textToSpeechReady;
  private boolean pendingVoiceAutoSend;
  private long lastVoiceLevelAt;
  private MediaRecorder cloudRecorder;
  private File cloudAudioFile;
  private boolean cloudRecording;
  private final Handler voiceHandler = new Handler(Looper.getMainLooper());
  private final Runnable cloudLevelRunnable = new Runnable() {
    @Override public void run() {
      if (!cloudRecording || cloudRecorder == null) return;
      int amplitude = cloudRecorder.getMaxAmplitude();
      postVoiceState("level", String.valueOf(Math.min(100, amplitude / 327)),
          pendingVoiceAutoSend);
      voiceHandler.postDelayed(this, 160);
    }
  };

  private void ensureResultChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel channel = new NotificationChannel(
          "asb_task_results", "Agent Bridge 任务结果", NotificationManager.IMPORTANCE_DEFAULT);
      getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }
  }

  void showTaskNotification(String title, String message) {
    ensureResultChannel();
    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, "asb_task_results")
        : new Notification.Builder(this);
    PendingIntent contentIntent = PendingIntent.getActivity(
        this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
    Notification notification = builder
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setContentTitle(title)
        .setContentText(message)
        .setContentIntent(contentIntent)
        .setAutoCancel(true)
        .build();
    getSystemService(NotificationManager.class).notify(RESULT_NOTIFICATION_ID, notification);
  }

  void startTaskForeground() {
    Intent intent = new Intent(this, TaskForegroundService.class);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent);
    else startService(intent);
  }

  void stopTaskForeground() {
    stopService(new Intent(this, TaskForegroundService.class));
  }

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS},
          REQUEST_NOTIFICATIONS);
    }
    webView = new WebView(this);
    if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
      WebView.setWebContentsDebuggingEnabled(true);
    }
    webView.setBackgroundColor(0xFFF7F2E7);
    webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

    @SuppressLint("SetJavaScriptEnabled")
    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
    settings.setMediaPlaybackRequiresUserGesture(false);
    settings.setSupportZoom(false);
    // Respect the page's phone-sized viewport meta tag without applying the
    // desktop-page overview zoom. This keeps layout, visual, and fixed layers
    // aligned, preventing a hidden 609px-wide horizontal scroll area.
    settings.setUseWideViewPort(true);
    settings.setLoadWithOverviewMode(false);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      settings.setSafeBrowsingEnabled(true);
    }

    webView.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
        return !isLocalAsset(request.getUrl().toString());
      }
      @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
        return !isLocalAsset(url);
      }
      private boolean isLocalAsset(String url) {
        return url.matches("file:///android_asset/(studio|phone)\\.html(?:#[a-zA-Z0-9=\\-]*)?");
      }
    });
    webView.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onConsoleMessage(ConsoleMessage message) {
        Log.d("AgentBridgeJS", message.lineNumber() + ":" + message.message());
        return true;
      }
    });
    bridge = new PhoneBridge(this);
    webView.addJavascriptInterface(bridge, "AgentBridge");
    webView.loadUrl("file:///android_asset/phone.html");
    webView.setLayoutParams(new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT));
    setContentView(webView, new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT));
    textToSpeech = new TextToSpeech(this, status -> {
      textToSpeechReady = status == TextToSpeech.SUCCESS;
      if (textToSpeechReady) {
        textToSpeech.setLanguage(new Locale("zh", "CN"));
      }
    });
  }

  void startVoiceRecognition(boolean autoSend) {
    runOnUiThread(() -> {
      pendingVoiceAutoSend = autoSend;
      if (textToSpeech != null) textToSpeech.stop();
      if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, REQUEST_VOICE);
        return;
      }
      startRecognizer();
    });
  }

  void stopVoiceRecognition() {
    runOnUiThread(() -> {
      if (cloudRecording) {
        stopCloudRecording();
        return;
      }
      if (recognizer != null) recognizer.stopListening();
    });
  }

  void cancelVoiceRecognition() {
    runOnUiThread(() -> {
      if (cloudRecording && cloudRecorder != null) {
        try {
          cloudRecorder.stop();
        } catch (Exception error) {
          // The recording is being discarded.
        }
        cleanupCloudRecorder();
        if (cloudAudioFile != null) cloudAudioFile.delete();
        postVoiceState("stopped", "", false);
        return;
      }
      if (recognizer != null) {
        recognizer.cancel();
        postVoiceState("stopped", "", false);
      }
    });
  }

  void speakText(String text) {
    runOnUiThread(() -> {
      if (!textToSpeechReady || textToSpeech == null) return;
      textToSpeech.setLanguage(new Locale("zh", "CN"));
      textToSpeech.speak(text, TextToSpeech.QUEUE_FLUSH, null, "butler-reply");
      postVoiceState("speaking", "", false);
    });
  }

  void stopSpeaking() {
    runOnUiThread(() -> {
      if (textToSpeech != null) textToSpeech.stop();
      postVoiceState("stopped", "", false);
    });
  }

  private void startRecognizer() {
    if (!SpeechRecognizer.isRecognitionAvailable(this)) {
      startCloudRecording();
      return;
    }
    if (recognizer == null) {
      recognizer = SpeechRecognizer.createSpeechRecognizer(this);
      recognizer.setRecognitionListener(new VoiceListener());
    }
    postVoiceState("ready", "", pendingVoiceAutoSend);
    Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
        .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
    recognizer.startListening(intent);
  }

  private void startCloudRecording() {
    try {
      cloudAudioFile = new File(getCacheDir(), "butler-voice.m4a");
      if (cloudAudioFile.exists() && !cloudAudioFile.delete()) {
        postVoiceState("error", "语音缓存文件无法清理", false);
        return;
      }
      cloudRecorder = new MediaRecorder();
      cloudRecorder.setAudioSource(MediaRecorder.AudioSource.MIC);
      cloudRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
      cloudRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
      cloudRecorder.setAudioSamplingRate(16_000);
      cloudRecorder.setAudioEncodingBitRate(24_000);
      cloudRecorder.setAudioChannels(1);
      cloudRecorder.setOutputFile(cloudAudioFile);
      cloudRecorder.prepare();
      cloudRecorder.start();
      cloudRecording = true;
      postVoiceState("cloud-recording", "", pendingVoiceAutoSend);
      voiceHandler.post(cloudLevelRunnable);
    } catch (Exception error) {
      cleanupCloudRecorder();
      postVoiceState("error", "录音启动失败，请检查麦克风权限", false);
    }
  }

  private void stopCloudRecording() {
    voiceHandler.removeCallbacks(cloudLevelRunnable);
    if (!cloudRecording || cloudRecorder == null) return;
    boolean failed = false;
    try {
      cloudRecorder.stop();
    } catch (Exception error) {
      failed = true;
    }
    cleanupCloudRecorder();
    if (failed || cloudAudioFile == null || !cloudAudioFile.exists() || cloudAudioFile.length() == 0) {
      postVoiceState("error", "没有录到有效语音", false);
      return;
    }
    postVoiceState("cloud-processing", "", pendingVoiceAutoSend);
    File audio = cloudAudioFile;
    boolean autoSend = pendingVoiceAutoSend;
    new Thread(() -> {
      try {
        byte[] bytes = Files.readAllBytes(audio.toPath());
        String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
        org.json.JSONObject parsed = bridge.transcribeVoiceAudio(base64, "audio/mp4");
        if (!parsed.optBoolean("ok")) {
          throw new IllegalStateException(parsed.optString("error", "语音识别失败"));
        }
        String text = parsed.getJSONObject("data").optString("text", "");
        if (text.trim().isEmpty()) throw new IllegalStateException("没有识别到文字");
        postVoiceState("final", text.trim(), autoSend);
      } catch (Exception error) {
        postVoiceState("error", "云端语音识别失败，请重试", false);
      } finally {
        boolean deleted = audio.delete();
        if (!deleted) {
          // A stale cache file will be replaced on the next recording.
        }
      }
    }, "agent-bridge-cloud-voice").start();
  }

  private void cleanupCloudRecorder() {
    cloudRecording = false;
    voiceHandler.removeCallbacks(cloudLevelRunnable);
    if (cloudRecorder != null) {
      cloudRecorder.release();
      cloudRecorder = null;
    }
  }

  private void postVoiceState(String type, String text, boolean autoSend) {
    runOnUiThread(() -> {
      if (webView == null || isFinishing() || isDestroyed()) return;
      String payload;
      try {
        payload = new org.json.JSONObject()
            .put("type", type)
            .put("text", text)
            .put("autoSend", autoSend)
            .toString();
      } catch (Exception error) {
        payload = "{\"type\":\"error\",\"text\":\"语音状态更新失败\",\"autoSend\":false}";
      }
      webView.evaluateJavascript("window.phoneVoice && window.phoneVoice.update(" + payload + ")", null);
    });
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (requestCode != REQUEST_VOICE) return;
    if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
      startRecognizer();
    } else {
      postVoiceState("error", "需要麦克风权限才能使用实时语音", false);
    }
  }

  @Override
  public void onBackPressed() {
    if (webView != null) {
      webView.evaluateJavascript(
          "Boolean(window.phoneUI && window.phoneUI.closeTopSheet())",
          handled -> {
            if (isFinishing() || isDestroyed() || "true".equals(handled)) return;
            if (webView != null && webView.canGoBack()) webView.goBack();
            else MainActivity.super.onBackPressed();
          });
      return;
    }
    super.onBackPressed();
  }

  @Override
  protected void onDestroy() {
    cleanupCloudRecorder();
    if (recognizer != null) {
      recognizer.destroy();
      recognizer = null;
    }
    if (textToSpeech != null) {
      textToSpeech.shutdown();
      textToSpeech = null;
    }
    if (bridge != null) bridge.close();
    if (webView != null) {
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }

  private final class VoiceListener implements RecognitionListener {
    @Override public void onReadyForSpeech(Bundle params) {
      postVoiceState("recording", "", pendingVoiceAutoSend);
    }

    @Override public void onBeginningOfSpeech() { }

    @Override public void onRmsChanged(float rmsdB) {
      long now = System.currentTimeMillis();
      if (now - lastVoiceLevelAt < 120) return;
      lastVoiceLevelAt = now;
      postVoiceState("level", String.valueOf(Math.max(0, Math.min(100, (rmsdB + 4) * 4))), pendingVoiceAutoSend);
    }

    @Override public void onBufferReceived(byte[] buffer) { }

    @Override public void onEndOfSpeech() {
      postVoiceState("processing", "", pendingVoiceAutoSend);
    }

    @Override public void onError(int error) {
      String message = error == SpeechRecognizer.ERROR_NO_MATCH
          ? "没有听到内容，请再按一次语音按钮"
          : error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
            ? "语音输入超时，请靠近麦克风再试"
            : "语音识别失败，请重试";
      postVoiceState("error", message, false);
    }

    @Override public void onResults(Bundle results) {
      ArrayList<String> values = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
      String text = values == null || values.isEmpty() ? "" : values.get(0);
      postVoiceState("final", text, pendingVoiceAutoSend);
    }

    @Override public void onPartialResults(Bundle partialResults) {
      ArrayList<String> values = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
      String text = values == null || values.isEmpty() ? "" : values.get(0);
      postVoiceState("partial", text, pendingVoiceAutoSend);
    }

    @Override public void onEvent(int eventType, Bundle params) { }
  }
}

package com.otterview.agentsessionbridge;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Native-only Hub transport. Tokens never return to JavaScript or follow redirects. */
final class StudioHubClient {
  private final SharedPreferences prefs;
  private static final String ALIAS = "asb-studio-hub-v1";

  StudioHubClient(Context context) {
    prefs = context.getSharedPreferences("studio_hub_v1", Context.MODE_PRIVATE);
  }

  private SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    if (!store.containsAlias(ALIAS)) {
      KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
      generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
      generator.generateKey();
    }
    return (SecretKey) store.getKey(ALIAS, null);
  }

  private synchronized JSONObject config() throws Exception {
    String saved = prefs.getString("encrypted", "");
    if (saved.isEmpty()) return new JSONObject();
    String[] pieces = saved.split("\\.");
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(pieces[0], Base64.NO_WRAP)));
    return new JSONObject(new String(cipher.doFinal(Base64.decode(pieces[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
  }

  private synchronized void save(JSONObject config) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key());
    String saved = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "."
        + Base64.encodeToString(cipher.doFinal(config.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
    if (!prefs.edit().putString("encrypted", saved).commit()) throw new IllegalStateException("Hub 设置保存失败");
  }

  synchronized String deviceId() {
    String id = prefs.getString("device_id", "");
    if (id.isEmpty()) {
      id = java.util.UUID.randomUUID().toString();
      if (!prefs.edit().putString("device_id", id).commit()) throw new IllegalStateException("设备标识保存失败");
    }
    return id;
  }

  synchronized long revision() {
    long next = prefs.getLong("revision", 0) + 1;
    if (!prefs.edit().putLong("revision", next).commit()) throw new IllegalStateException("同步版本保存失败");
    return next;
  }

  JSONObject publicSettings() throws Exception {
    JSONObject config = config();
    return new JSONObject().put("connected", config.has("baseUrl"))
        .put("baseUrl", config.optString("baseUrl"))
        .put("shareTasks", config.optBoolean("shareTasks"))
        .put("allowLocalHttp", config.optBoolean("allowLocalHttp"))
        .put("deviceId", deviceId());
  }

  JSONObject connect(String input) throws Exception {
    JSONObject next = new JSONObject(input);
    String base = validateBase(next.optString("baseUrl"), next.optBoolean("allowLocalHttp"));
    JSONObject old = config();
    String token = next.optString("token").trim();
    if (token.isEmpty() && base.equals(old.optString("baseUrl"))) token = old.optString("token");
    if (token.length() < 32 || token.length() > 4096 || !token.matches("[\\x21-\\x7e]+")) {
      throw new IllegalArgumentException("Hub Token 须为 32–4096 位可见 ASCII 字符，手机连接不接受无鉴权 Hub");
    }
    JSONObject candidate = new JSONObject().put("baseUrl", base).put("token", token)
        .put("shareTasks", next.optBoolean("shareTasks")).put("allowLocalHttp", next.optBoolean("allowLocalHttp"));
    JSONObject check = exchange(candidate, "/studio/state", "GET", "");
    if (!check.has("model") || !check.has("messages") || !check.has("memories")) throw new IllegalStateException("目标不是兼容的工作室 Hub");
    if (old.optBoolean("shareTasks") && !candidate.optBoolean("shareTasks") && base.equals(old.optString("baseUrl"))) {
      exchange(old, "/studio/devices/" + deviceId() + "/snapshot", "DELETE", "");
    }
    save(candidate);
    return publicSettings();
  }

  void disconnect() {
    if (!prefs.edit().remove("encrypted").commit()) throw new IllegalStateException("断开 Hub 失败");
  }

  JSONObject request(String route, String method, String body) throws Exception {
    JSONObject config = config();
    if (!config.has("baseUrl")) throw new IllegalStateException("请先连接 Hub");
    boolean allowed = ("GET".equals(method) && (route.equals("/studio/state") || route.equals("/studio/model") || route.matches("/studio/reports\\?date=\\d{4}-\\d{2}-\\d{2}")))
        || ("POST".equals(method) && (route.equals("/studio/messages") || route.equals("/studio/reports") || route.equals("/studio/memories") || route.equals("/studio/model/test") || route.equals("/studio/voice/transcriptions")
          || route.equals("/studio/devices/" + deviceId() + "/snapshot") || route.equals("/studio/devices/" + deviceId() + "/memories")))
        || ("PUT".equals(method) && route.equals("/studio/model"))
        || ("DELETE".equals(method) && (route.matches("/studio/memories/[a-f0-9-]{36}") || route.equals("/studio/devices/" + deviceId() + "/snapshot")));
    if (!allowed) throw new IllegalArgumentException("不允许的 Hub 请求");
    if (body.length() > 800_000) throw new IllegalArgumentException("同步内容过大");
    return exchange(config, route, method, body);
  }

  static String validateBase(String input, boolean allowLocalHttp) throws Exception {
    URL url = new URL(input.trim());
    String host = url.getHost();
    boolean local = host.equals("localhost") || host.equals("127.0.0.1") || host.equals("[::1]")
        || host.matches("10(?:\\.\\d{1,3}){3}") || host.matches("192\\.168(?:\\.\\d{1,3}){2}")
        || host.matches("172\\.(?:1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2}");
    if (!url.getProtocol().equals("https") && !(url.getProtocol().equals("http") && allowLocalHttp && local)) {
      throw new IllegalArgumentException("公网 Hub 必须使用 HTTPS；局域网 HTTP 需明确勾选允许");
    }
    if (url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null
        || !(url.getPath().isEmpty() || url.getPath().equals("/"))) {
      throw new IllegalArgumentException("Hub 地址只填协议、主机和端口，不带路径、凭据或参数");
    }
    return input.trim().replaceAll("/+$", "");
  }

  private JSONObject exchange(JSONObject config, String route, String method, String body) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(config.getString("baseUrl") + route).openConnection();
    try {
      connection.setInstanceFollowRedirects(false);
      connection.setConnectTimeout(10_000);
      connection.setReadTimeout(70_000);
      connection.setRequestMethod(method);
      connection.setRequestProperty("Authorization", "Bearer " + config.getString("token"));
      connection.setRequestProperty("Accept", "application/json");
      if (!body.isEmpty()) {
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(bytes.length);
        try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
      }
      int status = connection.getResponseCode();
      if (status >= 300 && status < 400) throw new IllegalStateException("Hub 返回重定向，已拒绝转发 Token；请填写最终 HTTPS 地址");
      if (status == 401 || status == 403) throw new IllegalStateException("Hub Token 无效或无权访问");
      try (InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
        if (input == null) throw new IllegalStateException("Hub 未返回内容");
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) {
          if (output.size() + count > 2_000_000) throw new IllegalStateException("Hub 响应过大");
          output.write(buffer, 0, count);
        }
        JSONObject result = new JSONObject(output.toString("UTF-8"));
        if (status >= 400) throw new IllegalStateException(result.optString("error", "Hub 请求失败").substring(0, Math.min(300, result.optString("error", "Hub 请求失败").length())));
        return result;
      }
    } finally { connection.disconnect(); }
  }
}

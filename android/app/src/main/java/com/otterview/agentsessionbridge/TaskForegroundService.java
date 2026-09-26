package com.otterview.agentsessionbridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

public class TaskForegroundService extends Service {
  private static final String CHANNEL_ID = "asb_task_service";
  private static final int NOTIFICATION_ID = 41026;

  private void ensureChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel channel = new NotificationChannel(
          CHANNEL_ID, "Agent Bridge 后台任务", NotificationManager.IMPORTANCE_LOW);
      getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public void onDestroy() {
    stopForeground(true);
    super.onDestroy();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    ensureChannel();
    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, CHANNEL_ID)
        : new Notification.Builder(this);
    Notification notification = builder
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setContentTitle("Agent Bridge 后台任务")
        .setContentText("正在执行远程任务")
        .setOngoing(true)
        .build();
    startForeground(NOTIFICATION_ID, notification);
    return START_STICKY;
  }
}

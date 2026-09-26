package com.otterview.agentsessionbridge;

public class TailOperationRunnable implements Runnable {
  private final PhoneBridge bridge;
  private final int taskId;
  private final int operationId;

  TailOperationRunnable(PhoneBridge bridge, int taskId, int operationId) {
    this.bridge = bridge;
    this.taskId = taskId;
    this.operationId = operationId;
  }

  @Override
  public void run() {
    bridge.tailTaskOperation(taskId, operationId);
  }
}

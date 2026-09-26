package com.otterview.agentsessionbridge;

public class DiscoverOperationRunnable implements Runnable {
  private final PhoneBridge bridge;
  private final int machineId;
  private final int operationId;

  DiscoverOperationRunnable(PhoneBridge bridge, int machineId, int operationId) {
    this.bridge = bridge;
    this.machineId = machineId;
    this.operationId = operationId;
  }

  @Override
  public void run() {
    bridge.discoverTasksOperation(machineId, operationId);
  }
}

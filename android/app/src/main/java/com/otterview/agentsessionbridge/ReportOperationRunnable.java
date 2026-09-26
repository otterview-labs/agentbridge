package com.otterview.agentsessionbridge;

public class ReportOperationRunnable implements Runnable {
  private final PhoneBridge bridge;
  private final String date;
  private final int operationId;

  ReportOperationRunnable(PhoneBridge bridge, String date, int operationId) {
    this.bridge = bridge;
    this.date = date;
    this.operationId = operationId;
  }

  @Override
  public void run() {
    bridge.studioReportOperation(date, operationId);
  }
}

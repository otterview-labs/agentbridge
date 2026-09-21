package com.otterview.agentsessionbridge;

public final class FrpScriptHarness {
  public static void main(String[] args) {
    if ("download".equals(args[0])) {
      System.out.print(FrpInstallSupport.download("https://fixture.invalid/checksums"));
    } else if ("download-github".equals(args[0])) {
      System.out.print(FrpInstallSupport.download("https://github.com/fatedier/frp/releases/download/v0.61.1/frp_sha256_checksums.txt"));
    } else if ("mac".equals(args[0])) {
      System.out.print(FrpInstallSupport.macLaunchAgent("asb-machine-2-ssh"));
    } else {
      throw new IllegalArgumentException("Unknown fixture");
    }
  }
}

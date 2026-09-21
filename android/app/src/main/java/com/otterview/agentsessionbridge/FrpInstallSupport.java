package com.otterview.agentsessionbridge;

/** Shell fragments shared by FRP installers, testable without Android. */
final class FrpInstallSupport {
  private FrpInstallSupport() {}

  static String download(String checksumUrl) {
    return "printf 'ASB_STAGE=download\\n'\n"
        + "asb_download() {\n"
        + "  destination=$1\n"
        + "  shift\n"
        + "  for url in \"$@\"; do\n"
        + "    curl -fsSL --connect-timeout 15 --max-time 60 --retry 1 \"$url\" -o \"$destination\" && return 0\n"
        + "    rm -f \"$destination\"\n"
        + "  done\n"
        + "  return 1\n"
        + "}\n"
        + "archive_downloaded=0\n"
        + "asb_download \"$work/frp.tar.gz\" \"$archive\" && archive_downloaded=1 || true\n"
        + "case \"$archive\" in https://github.com/*) asb_download \"$work/frp.tar.gz\" \"https://gh-proxy.com/$archive\" && archive_downloaded=1 || true ;; esac\n"
        + "[ \"$archive_downloaded\" -eq 1 ] || exit 1\n"
        + "checksum_url=" + shellUrl(checksumUrl) + "\n"
        + "checksum_downloaded=0\n"
        + "asb_download \"$work/checksums.txt\" \"$checksum_url\" && checksum_downloaded=1 || true\n"
        + "case \"$checksum_url\" in https://github.com/*) asb_download \"$work/checksums.txt\" \"https://gh-proxy.com/$checksum_url\" && checksum_downloaded=1 || true ;; esac\n"
        + "[ \"$checksum_downloaded\" -eq 1 ] || exit 1\n"
        + "printf 'ASB_STAGE=checksum\\n'\n"
        + "expected=$(awk -v name=\"$(basename \"$archive\")\" '$2 == name || $2 == \"*\" name {print $1}' \"$work/checksums.txt\")\n"
        + "[ \"${#expected}\" -eq 64 ] || { echo 'Missing or duplicate FRP checksum entry' >&2; exit 2; }\n"
        + "case \"$expected\" in *[!0-9a-fA-F]*) echo 'Invalid FRP checksum' >&2; exit 2 ;; esac\n"
        + "if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum \"$work/frp.tar.gz\");\n"
        + "elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 \"$work/frp.tar.gz\");\n"
        + "else echo 'Need sha256sum or shasum to verify FRP' >&2; exit 2; fi\n"
        + "actual=${actual%% *}\n"
        + "[ \"$(printf '%s' \"$actual\" | tr 'A-F' 'a-f')\" = \"$(printf '%s' \"$expected\" | tr 'A-F' 'a-f')\" ] "
        + "|| { echo 'FRP checksum mismatch; installation stopped' >&2; exit 2; }\n"
        + "printf 'ASB_STAGE=install\\n'\n";
  }

  static String macLaunchAgent(String label) {
    if (!label.matches("[A-Za-z0-9_.-]+")) throw new IllegalArgumentException("Invalid launch agent label");
    return "printf 'ASB_STAGE=launch-agent\\n'\n"
        + "domain=\"gui/$(id -u)\"\n"
        + "launchctl print \"$domain\" >/dev/null 2>&1 || { echo 'Mac GUI session unavailable; sign in to the Mac desktop before enabling remote access' >&2; exit 2; }\n"
        + "mkdir -p \"$HOME/Library/LaunchAgents\"\n"
        + "plist=\"$HOME/Library/LaunchAgents/com.agent-session-bridge.frpc." + label + ".plist\"\n"
        + "home_xml=$(printf '%s' \"$HOME\" | sed 's/\\&/\\&amp;/g;s/</\\&lt;/g;s/>/\\&gt;/g')\n"
        + "cat > \"$plist\" <<PLIST\n"
        + "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict>"
        + "<key>Label</key><string>com.agent-session-bridge.frpc." + label + "</string>"
        + "<key>ProgramArguments</key><array><string>${home_xml}/.asb-frp/bin/frpc</string><string>-c</string>"
        + "<string>${home_xml}/.config/agent-session-bridge/frpc.toml</string></array>"
        + "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>"
        + "<key>StandardOutPath</key><string>${home_xml}/.asb-frp/frpc.log</string>"
        + "<key>StandardErrorPath</key><string>${home_xml}/.asb-frp/frpc-error.log</string>"
        + "</dict></plist>\nPLIST\n"
        + "plutil -lint \"$plist\" >/dev/null\n"
        + "launchctl bootout \"$domain\" \"$plist\" >/dev/null 2>&1 || true\n"
        + "launchctl bootstrap \"$domain\" \"$plist\"\n"
        + "launchctl kickstart \"$domain/com.agent-session-bridge.frpc." + label + "\"\n"
        + "sleep 1\n"
        + "launchctl print \"$domain/com.agent-session-bridge.frpc." + label + "\" | grep -q 'state = running' "
        + "|| { echo 'FRP launch agent is not running; inspect ~/.asb-frp/frpc-error.log' >&2; exit 2; }\n";
  }

  static String quote(String value) {
    return "'" + value.replace("'", "'\\''") + "'";
  }

  private static String shellUrl(String value) {
    if (!value.matches("[!#$%&()*+,./:;=?@A-Za-z0-9_-]+")) {
      throw new IllegalArgumentException("Invalid FRP download URL");
    }
    return value;
  }
}

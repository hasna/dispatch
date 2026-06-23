import { describe, expect, test } from "bun:test";
import { buildSystemdUserUnit, systemdUserUnitPath } from "./service.js";

describe("daemon systemd service helpers", () => {
  test("buildSystemdUserUnit points at daemon run and avoids tight restart loops", () => {
    const unit = buildSystemdUserUnit({
      execPath: "/home/hasna/.bun/bin/bun",
      cliEntry: "/home/hasna/.bun/bin/dispatch",
      dataDir: "/tmp/dispatch-data",
    });

    expect(unit).toContain("Environment=DISPATCH_DATA_DIR=/tmp/dispatch-data");
    expect(unit).toContain("ExecStart=/home/hasna/.bun/bin/bun /home/hasna/.bun/bin/dispatch daemon run");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=10s");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("systemdUserUnitPath uses the user systemd unit directory", () => {
    expect(systemdUserUnitPath()).toMatch(/\.config\/systemd\/user\/hasna-dispatch-daemon\.service$/);
  });
});

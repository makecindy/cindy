import { generateKeyPairSync } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Server, utils, type Connection } from "ssh2";
import type { Logger } from "@cindy/maker-core";
import { TerminalSshService } from "../ssh.js";

/** Real SSH and reverse forwarding, confined to a disposable home and loopback.
 * No system sshd, user configuration, credential home or external account. */
export async function loopbackSsh(
  root: string,
  piBinary: string,
  runtimeDirectory: string,
  logger: Logger,
  engines: { codexPackage?: string; claudeBinary?: string } = {},
) {
  const remoteHome = path.join(root, "remote");
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error || Array.isArray(parsed))
    throw new Error("SSH_TEST_KEY_INVALID");
  const publicKey = parsed.getPublicSSH(),
    keyFile = path.join(root, "identity");
  const installRoot = path.join(remoteHome, ".xdt-server/v1");
  await mkdir(path.join(installRoot, "pi"), { recursive: true });
  await mkdir(path.join(installRoot, "node/bin"), { recursive: true });
  await mkdir(path.join(root, "tmp"), { recursive: true });
  await writeFile(keyFile, key, { mode: 0o600 });
  await symlink(piBinary, path.join(installRoot, "pi/pi"));
  await symlink(process.execPath, path.join(installRoot, "node/bin/node"));
  if (engines.codexPackage) {
    const standalone = path.join(installRoot, 'codex-home/packages/standalone');
    await mkdir(standalone, { recursive: true });
    await cp(engines.codexPackage, path.join(standalone, 'fixture'), { recursive: true });
    await symlink('bin/codex', path.join(standalone, 'fixture/codex'));
    await symlink('fixture', path.join(standalone, 'current'));
    await writeFile(path.join(installRoot, '.installed-codex'), 'isolated native test');
  }
  if (engines.claudeBinary) {
    await mkdir(path.join(installRoot, 'node_modules/.bin'), { recursive: true });
    await symlink(engines.claudeBinary, path.join(installRoot, 'node_modules/.bin/claude'));
    await writeFile(path.join(installRoot, '.installed-claude-code'), 'isolated native test');
  }
  const clients = new Set<Connection>(),
    children = new Set<ChildProcess>(),
    listeners = new Set<net.Server>(),
    sockets = new Set<net.Socket>();
  const forwardPorts: number[] = [];
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const sshd = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    const forwards = new Map<number, net.Server>();
    client.on("authentication", (ctx) => {
      if (
        ctx.method === "publickey" &&
        ctx.key.data.equals(publicKey) &&
        (!ctx.signature ||
          (ctx.blob && parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo)))
      )
        ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (accept, _reject, info) => {
          const channel = accept();
          const child = spawn("/bin/bash", ["-c", info.command], {
            cwd: remoteHome,
            env: {
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              HOME: remoteHome,
              LANG: "en_US.UTF-8",
              TMPDIR: path.join(root, "tmp"),
            },
            stdio: "pipe",
          });
          children.add(child);
          channel.pipe(child.stdin);
          child.stdout.pipe(channel, { end: false });
          child.stderr.pipe(channel.stderr);
          child.on("error", () => {
            channel.exit(1);
            channel.end();
          });
          child.on("close", (code) => {
            children.delete(child);
            channel.exit(code ?? 1);
            channel.end();
          });
          channel.on("close", () => {
            child.stdin.destroy();
            if (child.exitCode === null) child.kill();
          });
          channel.on("error", () => child.kill());
          child.stdin.on("error", () => {});
        });
      });
      client.on("request", (accept, reject, name, info) => {
        if (name === "cancel-tcpip-forward") {
          const server = forwards.get(info.bindPort);
          server?.close();
          forwards.delete(info.bindPort);
          if (server) listeners.delete(server);
          accept?.();
          return;
        }
        if (
          name !== "tcpip-forward" ||
          !["127.0.0.1", "localhost"].includes(info.bindAddr)
        ) {
          reject?.();
          return;
        }
        const server = net.createServer((socket) => {
          track(socket);
          const port = (server.address() as net.AddressInfo).port;
          client.forwardOut(
            "127.0.0.1",
            port,
            socket.remoteAddress ?? "127.0.0.1",
            socket.remotePort ?? 1,
            (error, channel) => {
              if (error) {
                socket.destroy();
                return;
              }
              socket.pipe(channel).pipe(socket);
              channel.on("error", () => socket.destroy());
            },
          );
        });
        server.once("error", () => reject?.());
        server.listen(info.bindPort, "127.0.0.1", () => {
          const port = (server.address() as net.AddressInfo).port;
          forwardPorts.push(port);
          forwards.set(port, server);
          listeners.add(server);
          accept?.(port);
        });
      });
      client.on("tcpip", (accept, _reject, info) => {
        const socket = track(net.connect(info.destPort, info.destIP));
        const channel = accept();
        socket.pipe(channel).pipe(socket);
        channel.on("error", () => socket.destroy());
      });
    });
    client.on("close", () => {
      for (const server of forwards.values()) {
        server.close();
        listeners.delete(server);
      }
      forwards.clear();
    });
  });
  await new Promise<void>((resolve, reject) => {
    sshd.once("error", reject);
    sshd.listen(0, "127.0.0.1", resolve);
  });
  const service = new TerminalSshService(path.join(root, "ssh"), () => {}, {
    logger,
    runtimeDirectory,
    ownerScope: () => root,
    assertCurrent() {},
  });
  await mkdir(path.join(root, "ssh"), { recursive: true });
  await service.pool.hydrate([
    {
      id: "fixture",
      hostname: "127.0.0.1",
      port: (sshd.address() as net.AddressInfo).port,
      user: "fixture",
      authMethod: "key",
      identityFile: keyFile,
      source: "ssh-config",
      managedByCindy: false,
    },
  ]);
  return {
    service,
    remoteHome,
    forwardPorts,
    async close() {
      // A transport recovery assertion may finish while disconnected. Reconnect
      // only this disposable host so its native daemons are still retired.
      if (service.pool.get("fixture")?.getStatus() !== "ready")
        await service.pool.connect("fixture").catch(() => {});
      const host = service.pool.get("fixture");
      if (host?.getStatus() === "ready")
        await service.piManager.killRemotePiManagerDaemon(host).catch(() => {});
      if (host?.getStatus() === 'ready' && engines.codexPackage)
        await host.exec('export CODEX_HOME="$HOME/.xdt-server/v1/codex-home"; "$CODEX_HOME/packages/standalone/current/codex" app-server daemon stop', {timeoutMs:15000,label:'test-codex-daemon-stop'}).catch(()=>{});
      if (host?.getStatus() === 'ready' && engines.claudeBinary)
        await host.exec('D="$(cd "$HOME/.xdt-server/v1/cc-manager" && pwd -P)"; PID="$(cat "$D/cc-mgr.pid" 2>/dev/null)"; CMD="$(ps -p "$PID" -o command= 2>/dev/null)"; case "$CMD" in *"$D/cc-mgr.mjs"*|*"$HOME/.xdt-server/v1/cc-manager/cc-mgr.mjs"*) kill "$PID";; esac', {timeoutMs:5000,label:'test-cc-manager-stop'}).catch(()=>{});
      await service.close();
      for (const client of clients) client.end();
      for (const socket of sockets) socket.destroy();
      for (const child of children) child.kill();
      await Promise.all(
        [...listeners].map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
      await new Promise<void>((resolve) => sshd.close(() => resolve()));
    },
  };
}

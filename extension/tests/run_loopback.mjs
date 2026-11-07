// run_loopback.mjs — self-contained DLL<->server interop test.
//
// Listens on a named pipe as the MCP gateway, spawns the compiled loopback_driver
// (the C++ Bridge acting as the DLL client) at it, and asserts:
//   - hello / sessionInfo / execResult frames arrive as valid {"v":1,...} JSON with
//     the WrapBody envelope correctly stamped around the SQF-built bodies
//   - hello carries the driver's own pid
//   - an exec frame sent back is parsed + routed by the DLL to the right
//     parseSimpleArray payload
//
// It runs twice. The first run passes the listening pipe on the command line, as
// SQF does. The second passes a wrong pipe and sets ARMA_MCP_GAME_PIPE to the
// listening one, as the daemon does for a test stack; the driver must still arrive.
//
// Build the driver first (see docs/testing.md), then:
//   node extension/tests/run_loopback.mjs <path-to-loopback_driver.exe>
import net from 'node:net';
import { spawn } from 'node:child_process';

const driverExe = process.argv[2];
if (!driverExe) {
  console.error('usage: node run_loopback.mjs <loopback_driver.exe>');
  process.exit(2);
}

function makeDecoder() {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const out = [];
    for (;;) {
      if (buf.length < 4) break;
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      out.push(buf.subarray(4, 4 + n).toString('utf8'));
      buf = buf.subarray(4 + n);
    }
    return out;
  };
}
function encode(s) {
  const p = Buffer.from(s, 'utf8');
  const h = Buffer.alloc(4);
  h.writeUInt32LE(p.length, 0);
  return Buffer.concat([h, p]);
}

function runOnce(label, { argvPipe, envPipe }) {
  const pipe = `\\\\.\\pipe\\arma_mcp_lb_${process.pid}_${label}`;
  return new Promise((resolve) => {
    let failures = 0;
    const seen = { hello: false, sessionInfo: false, execResult: false };
    let helloPid = null;
    let driverOut = '';
    let childPid = null;

    const server = net.createServer((sock) => {
      const decode = makeDecoder();
      sock.on('data', (chunk) => {
        for (const payload of decode(chunk)) {
          let m;
          try { m = JSON.parse(payload); } catch { failures++; console.error('bad JSON:', payload); continue; }
          if (m.v !== 1) { failures++; console.error('missing v:1', payload); }
          if (m.type === 'hello') {
            seen.hello = true;
            helloPid = m.pid;
            if (typeof m.ver !== 'string' || !m.ver.startsWith('ArmaMCP ')) { failures++; console.error('hello ver wrong', payload); }
          }
          if (m.type === 'sessionInfo') {
            seen.sessionInfo = true;
            if (m.world !== 'Altis' || m.mission !== 'co40_loop') { failures++; console.error('sessionInfo body wrong', payload); }
          }
          if (m.type === 'execResult') {
            seen.execResult = true;
            if (m.reqId !== 'r1' || m.machine !== 'server' || m.result !== 'SCALAR: 2') { failures++; console.error('execResult body wrong', payload); }
            sock.write(encode(JSON.stringify({ v: 1, type: 'exec', reqId: 'e1', mode: 'server', target: '', code: '1+1', label: 'loop' })));
          }
        }
      });
      sock.on('error', () => {});
    });

    server.on('error', (e) => { console.error('server error', e.message); resolve(false); });

    const timer = setTimeout(() => {
      console.log(`[${label}] LOOPBACK FAIL (timeout)`);
      server.close();
      resolve(false);
    }, 10000);

    server.listen(pipe, () => {
      console.error(`[${label}] listening on`, pipe);
      const env = { ...process.env };
      delete env.ARMA_MCP_GAME_PIPE;
      if (envPipe) env.ARMA_MCP_GAME_PIPE = pipe;
      const target = argvPipe === 'listening' ? pipe : argvPipe;
      const child = spawn(driverExe, [target], { stdio: ['ignore', 'pipe', 'pipe'], env });
      childPid = child.pid;
      child.stdout.on('data', (d) => { driverOut += d.toString(); });
      child.stderr.on('data', (d) => { driverOut += d.toString(); });
      child.on('exit', (code) => {
        setTimeout(() => {
          clearTimeout(timer);
          const pidOk = helloPid === childPid;
          if (!pidOk) console.error(`[${label}] hello pid ${helloPid} != driver pid ${childPid}`);
          const ok = seen.hello && seen.sessionInfo && seen.execResult && pidOk && failures === 0 && code === 0;
          console.log(`[${label}] driver:`, driverOut.trim());
          console.log(`[${label}] peer: hello=${seen.hello} pid=${pidOk} session=${seen.sessionInfo} result=${seen.execResult} failures=${failures} driverExit=${code}`);
          console.log(`[${label}] ${ok ? 'LOOPBACK PASS' : 'LOOPBACK FAIL'}`);
          server.close();
          resolve(ok);
        }, 200);
      });
    });
  });
}

const direct = await runOnce('argv', { argvPipe: 'listening', envPipe: false });
const override = await runOnce('env', {
  argvPipe: `\\\\.\\pipe\\arma_mcp_lb_${process.pid}_nobody`,
  envPipe: true,
});
const ok = direct && override;
console.log(ok ? 'LOOPBACK PASS' : 'LOOPBACK FAIL');
process.exit(ok ? 0 : 1);

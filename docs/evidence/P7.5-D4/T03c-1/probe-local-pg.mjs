// Diagnostic only: fixed local port, no password, authentication or SQL query.
// Prints protocol response metadata only, never the received payload.
import net from 'node:net';
import { performance } from 'node:perf_hooks';

function packet(probe) {
  if (probe === 'ssl') {
    const value = Buffer.alloc(8);
    value.writeInt32BE(8, 0);
    value.writeInt32BE(80877103, 4);
    return value;
  }
  const params = Buffer.from(
    'user\0postgres\0database\0postgres\0application_name\0ragbot_local_probe\0\0',
  );
  const value = Buffer.alloc(8 + params.length);
  value.writeInt32BE(value.length, 0);
  value.writeInt32BE(196608, 4); // PostgreSQL protocol 3.0.
  params.copy(value, 8);
  return value;
}

function probe(kind) {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = net.createConnection({ host: '127.0.0.1', port: 54322 });
    let done = false;
    let connected = false;
    const finish = (fields) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({
        probe: kind,
        connected,
        elapsedMs: Math.round(performance.now() - start),
        ...fields,
      });
    };
    const timer = setTimeout(() => finish({ error: 'protocol_timeout' }), 5000);
    socket.once('connect', () => {
      connected = true;
      socket.write(packet(kind));
    });
    socket.once('data', (data) => {
      finish({
        responseType: String.fromCharCode(data[0]),
        responseBytes: data.length,
        ...(kind === 'startup' && data[0] === 82 && data.length >= 9
          ? { authenticationMethod: data.readInt32BE(5) }
          : {}),
      });
    });
    socket.once('error', (error) => finish({ error: error.code ?? 'network_error' }));
    socket.once('end', () => finish({ error: 'closed_before_response' }));
  });
}

console.log(JSON.stringify([await probe('ssl'), await probe('startup')]));

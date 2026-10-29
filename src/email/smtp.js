import net from 'node:net';
import tls from 'node:tls';

/**
 * Minimal SMTP client over implicit TLS (port 465), enough to send one
 * message. Kept dependency-free on purpose; used by the Gmail driver.
 */

function encodeHeader(value) {
  // RFC 2047 encode if the header contains non-ASCII.
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function dotStuff(body) {
  return body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

export async function sendSmtp({ host, port = 465, user, pass, from, to, subject, html, text }) {
  const boundary = `ctadi_${Date.now().toString(36)}`;
  const body = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text || '', 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html || '', 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, () => {});
    let buffer = '';
    let step = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.end();
      resolve(result);
    };

    const send = (line) => socket.write(`${line}\r\n`);
    const script = [
      () => send(`EHLO ctadi.local`),
      () => send('AUTH LOGIN'),
      () => send(Buffer.from(user, 'utf8').toString('base64')),
      () => send(Buffer.from(pass, 'utf8').toString('base64')),
      () => send(`MAIL FROM:<${user}>`),
      () => send(`RCPT TO:<${to}>`),
      () => send('DATA'),
      () => {
        socket.write(dotStuff(body));
        send('.');
      },
      () => done({ id: `smtp_${Date.now()}`, driver: 'gmail' }),
    ];

    socket.setTimeout(30000, () => fail(new Error('SMTP timeout')));
    socket.on('error', fail);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (/^\d{3} /.test(line)) {
          const code = Number(line.slice(0, 3));
          if (code >= 400) return fail(new Error(`SMTP error: ${line}`));
          const fn = script[step];
          step += 1;
          if (fn) fn();
        }
      }
    });
  });
}

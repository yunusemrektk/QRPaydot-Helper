'use strict';

const net = require('net');
const { CUT_FULL } = require('./escpos');

function sendToPrinter(host, port, payloadBuffers, cut) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(
      {
        host,
        port,
        timeout: 12000,
      },
      () => {
        let chain = Promise.resolve();
        for (const buf of payloadBuffers) {
          chain = chain.then(
            () =>
              new Promise((res, rej) => {
                socket.write(buf, (err) => (err ? rej(err) : res()));
              }),
          );
        }
        chain
          .then(() => {
            if (cut) {
              return new Promise((res, rej) => {
                socket.write(CUT_FULL, (e) => (e ? rej(e) : res()));
              });
            }
          })
          .then(() => {
            socket.end();
            resolve();
          })
          .catch((err) => {
            socket.destroy();
            reject(err);
          });
      },
    );

    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('socket timeout'));
    });
  });
}

module.exports = { sendToPrinter };

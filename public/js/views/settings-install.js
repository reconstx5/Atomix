// Settings → Profile → Install Atomix (v0.21): install the app on this device, or how to, or why it can't here.
import { h } from '../dom.js';
import { button, toast } from '../components.js';
import { secure, installed, installPrompt } from '../offline/install.js';

const INSECURE = 'Installing and downloads need a secure address (https:// or this computer’s own localhost). On this address you can still save a file from a title’s “…”.';

export function installCard() {
  const body = h('div', { class: 'stack' });
  const prompt = installPrompt();
  const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const draw = () => {
    body.replaceChildren();
    if (!secure()) return body.append(h('p', { class: 'muted' }, INSECURE));
    if (installed()) return body.append(h('p', {}, 'Atomix is installed on this device. Its downloads play with no connection.'), h('p', {}, h('a', { href: '#/downloads' }, 'Your downloads')));
    body.append(h('p', { class: 'muted' }, 'Put Atomix on this device’s home screen like an app, and download films, shows and music to watch offline.'));
    if (prompt.available) {
      body.append(
        h(
          'div',
          { class: 'actions' },
          button('Install Atomix', {
            icon: 'download',
            variant: 'primary',
            onClick: async () => {
              if ((await prompt.prompt()) === 'accepted') toast('Atomix is installing', { type: 'success' });
              draw();
            },
          }),
        ),
      );
    } else body.append(h('p', {}, iphone ? 'In Safari: Share → Add to Home Screen.' : 'Use your browser’s menu: Install Atomix (or Add to Home screen).'));
    body.append(h('p', {}, h('a', { href: '#/downloads' }, 'Your downloads')));
  };
  prompt.onChange(draw);
  draw();
  return h('section', { class: 'panel install-card' }, h('h2', {}, 'Install Atomix'), body);
}

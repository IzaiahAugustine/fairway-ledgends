// On-screen controls for phones and tablets. Each button stands in for a keyboard key: it sends
// the same key events the round already listens for, so touch and keyboard play identically.
// The swing itself needs no button: dragging a finger on the course works like the mouse.
import { isTouchDevice } from '../core/device';
import { h } from './dom';

/** A phone or tablet: the main pointer is a finger. */
export const isTouch = isTouchDevice;

/** Key events sent by these buttons carry this flag, so menu keyboard navigation ignores them. */
export const TOUCH_KEY = '__touchKey';

function send(type: 'keydown' | 'keyup', key: string) {
  const e = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
  (e as unknown as Record<string, boolean>)[TOUCH_KEY] = true;
  window.dispatchEvent(e);
}

const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1.5"/><rect x="14" y="4" width="5" height="16" rx="1.5"/></svg>';

export interface TouchState {
  aim: boolean;
  putting: boolean;
  skip: boolean;
  inRound: boolean;
}

export class TouchControls {
  readonly root: HTMLElement;
  private aimPad: HTMLElement;
  private shotBtns: HTMLElement[] = [];
  private skipBtn: HTMLElement;
  private cardBtn: HTMLElement;
  private cardOpen = false;
  private last = '';

  constructor(parent: HTMLElement, onPause: () => void) {
    this.root = h('div', { class: 'touch hidden' });
    parent.append(this.root);

    // held buttons: key down while the finger is on them
    const hold = (label: string, key: string, cls = '') => {
      const b = h('button', { class: `tbtn ${cls}`, 'aria-label': label });
      b.innerHTML = label;
      let on = false;
      const up = () => {
        if (!on) return;
        on = false;
        b.classList.remove('on');
        send('keyup', key);
      };
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        b.setPointerCapture?.(e.pointerId);
        on = true;
        b.classList.add('on');
        send('keydown', key);
      });
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
      return b;
    };
    // tapped buttons: one key press
    const tap = (label: string, key: string | (() => void), cls = '') => {
      const b = h('button', { class: `tbtn ${cls}` });
      b.innerHTML = label;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (typeof key === 'function') key();
        else {
          send('keydown', key);
          send('keyup', key);
        }
      });
      return b;
    };
    const col = (...kids: HTMLElement[]) => {
      const d = h('div', { class: 'tcol' });
      d.append(...kids);
      return d;
    };

    // bottom left: aim and power, held
    this.aimPad = h('div', { class: 'tpad' });
    this.aimPad.append(
      hold('◀<small>Aim</small>', 'a'),
      hold('▶<small>Aim</small>', 'd'),
      hold('▼<small>Power</small>', 's'),
      hold('▲<small>Power</small>', 'w'),
    );

    // bottom right: club, then spin and shot type
    const row = (...kids: HTMLElement[]) => {
      const d = h('div', { class: 'trow' });
      d.append(...kids);
      return d;
    };
    const spin = tap('Spin', 'c', 'pill');
    const shotRow = row(spin, tap('◀', 'q', 'sm'), h('span', { class: 'tlabel' }, 'Shot'), tap('▶', 'e', 'sm'));
    this.shotBtns = [shotRow];
    const right = col(row(tap('◀', 'ArrowLeft', 'sm'), h('span', { class: 'tlabel' }, 'Club'), tap('▶', 'ArrowRight', 'sm')), shotRow);
    right.classList.add('tright');

    // right edge: pause, scorecard and camera views
    const pause = tap(PAUSE_ICON, onPause, 'side');
    this.cardBtn = tap('Card', () => this.toggleCard(), 'side');
    const side = col(pause, this.cardBtn, tap('Target', 'v', 'side aim-only'), tap('Green', 'g', 'side aim-only'));
    side.classList.add('tside');

    this.skipBtn = tap('Skip ▶▶', () => {
      send('keydown', ' ');
      send('keyup', ' ');
      send('keydown', 'Enter');
      send('keyup', 'Enter');
    }, 'pill skip');

    this.root.append(this.aimPad, right, side, this.skipBtn);
  }

  private toggleCard() {
    this.cardOpen = !this.cardOpen;
    this.cardBtn.classList.toggle('on', this.cardOpen);
    send(this.cardOpen ? 'keydown' : 'keyup', 'Tab');
  }

  /** Called every frame; only touches the DOM when what's shown changes. */
  update(s: TouchState | null) {
    const key = s ? `${s.inRound}|${s.aim}|${s.putting}|${s.skip}` : '';
    if (key === this.last) return;
    this.last = key;
    if (!s || !s.inRound) {
      if (this.cardOpen) this.toggleCard();
      this.root.classList.add('hidden');
      return;
    }
    this.root.classList.remove('hidden');
    this.root.classList.toggle('aiming', s.aim);
    for (const b of this.shotBtns) b.classList.toggle('hidden', s.putting);
    this.skipBtn.classList.toggle('hidden', !s.skip);
  }
}

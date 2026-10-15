// Game-portal integration (Poki, CrazyGames): their SDK, gameplay events and ad breaks.
//
// The portal is picked at build time (`npm run build:poki` / `build:crazygames` set VITE_PORTAL),
// or at runtime from the page's host. Anywhere else (the game's own site, the dev server) every
// call here is a no-op and no SDK script is loaded, so there are never ads off-portal.
//
// Both portals require the game to be paused and silent while an ad plays: onAdStart/onAdEnd
// (set by main) do that.

type PortalId = 'poki' | 'crazygames' | null;

interface PokiSDKApi {
  init(): Promise<void>;
  gameLoadingFinished(): void;
  gameplayStart(): void;
  gameplayStop(): void;
  commercialBreak(onStart?: () => void): Promise<void>;
  rewardedBreak(onStart?: () => void): Promise<boolean>;
}
interface CrazySDKApi {
  init(): Promise<void>;
  environment: 'local' | 'crazygames' | 'disabled';
  game: {
    gameplayStart(): void;
    gameplayStop(): void;
    loadingStart(): void;
    loadingStop(): void;
    happytime(): void;
    settings?: { muteAudio?: boolean };
    addSettingsChangeListener?(cb: (s: { muteAudio?: boolean }) => void): void;
  };
  ad: { requestAd(kind: 'midgame' | 'rewarded', cb: { adStarted?: () => void; adFinished?: () => void; adError?: (e: unknown) => void }): void };
}
declare global {
  interface Window {
    PokiSDK?: PokiSDKApi;
    CrazyGames?: { SDK: CrazySDKApi };
  }
}

const SCRIPTS: Record<Exclude<PortalId, null>, string> = {
  poki: 'https://game-cdn.poki.com/scripts/v2/poki-sdk.js',
  crazygames: 'https://sdk.crazygames.com/crazygames-sdk-v3.js',
};

function detect(): PortalId {
  const built = import.meta.env.VITE_PORTAL as string | undefined;
  if (built === 'poki' || built === 'crazygames') return built;
  const host = location.hostname + ' ' + document.referrer;
  if (/poki/i.test(host)) return 'poki';
  if (/crazygames/i.test(host)) return 'crazygames';
  return null;
}

function loadScript(src: string): Promise<void> {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => res();
    s.onerror = () => rej(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}

class Portal {
  readonly id: PortalId = detect();
  private ready = false;
  private inGameplay = false;
  private adBusy = false;
  /** Pause the game and mute audio while an ad plays. */
  onAdStart: () => void = () => {};
  onAdEnd: () => void = () => {};
  /** The portal's own mute (CrazyGames' site-wide sound toggle); it overrides the game's setting. */
  muted = false;
  onMuteChange: () => void = () => {};

  /** True when ads can be requested (on a portal and its SDK came up). */
  get active() {
    return this.ready;
  }

  async init() {
    if (!this.id) return;
    try {
      await loadScript(SCRIPTS[this.id]);
      if (this.id === 'poki') await window.PokiSDK!.init();
      else {
        await window.CrazyGames!.SDK.init();
        const sdk = window.CrazyGames!.SDK;
        if (sdk.environment === 'disabled') return;
        sdk.game.loadingStart();
        this.muted = !!sdk.game.settings?.muteAudio;
        sdk.game.addSettingsChangeListener?.((s) => {
          this.muted = !!s.muteAudio;
          this.onMuteChange();
        });
      }
      this.ready = true;
    } catch (e) {
      // ad blockers and the like: the game simply runs without ads
      console.warn('[portal] SDK unavailable', e);
    }
  }

  loadingFinished() {
    if (!this.ready) return;
    if (this.id === 'poki') window.PokiSDK!.gameLoadingFinished();
    else window.CrazyGames!.SDK.game.loadingStop();
  }

  gameplayStart() {
    if (!this.ready || this.inGameplay) return;
    this.inGameplay = true;
    if (this.id === 'poki') window.PokiSDK!.gameplayStart();
    else window.CrazyGames!.SDK.game.gameplayStart();
  }

  gameplayStop() {
    if (!this.ready || !this.inGameplay) return;
    this.inGameplay = false;
    if (this.id === 'poki') window.PokiSDK!.gameplayStop();
    else window.CrazyGames!.SDK.game.gameplayStop();
  }

  happyTime() {
    if (this.ready && this.id === 'crazygames') window.CrazyGames!.SDK.game.happytime();
  }

  /** An ad at a natural break (between holes). Resolves when play can continue, ad or not. */
  async commercialBreak(): Promise<void> {
    if (!this.ready || this.adBusy) return;
    this.adBusy = true;
    const wasPlaying = this.inGameplay;
    this.gameplayStop();
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      this.onAdStart();
    };
    try {
      if (this.id === 'poki') await window.PokiSDK!.commercialBreak(start);
      else
        await new Promise<void>((res) =>
          window.CrazyGames!.SDK.ad.requestAd('midgame', { adStarted: start, adFinished: () => res(), adError: () => res() }),
        );
    } catch {
      // no ad: carry on
    } finally {
      if (started) this.onAdEnd();
      this.adBusy = false;
      if (wasPlaying) this.gameplayStart();
    }
  }

  /** An ad the player chose to watch for a reward. Resolves true if the reward is earned. */
  async rewardedBreak(): Promise<boolean> {
    if (!this.ready || this.adBusy) return false;
    this.adBusy = true;
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      this.onAdStart();
    };
    try {
      if (this.id === 'poki') return await window.PokiSDK!.rewardedBreak(start);
      return await new Promise<boolean>((res) =>
        window.CrazyGames!.SDK.ad.requestAd('rewarded', { adStarted: start, adFinished: () => res(true), adError: () => res(false) }),
      );
    } catch {
      return false;
    } finally {
      if (started) this.onAdEnd();
      this.adBusy = false;
    }
  }
}

export const portal = new Portal();

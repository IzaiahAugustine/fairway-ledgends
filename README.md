# Fairway Legends

A 1v1 golf game against an AI opponent (match play, stroke play or skins), built with Three.js + TypeScript. The
golfer, clubs, trees and course props are modelled, rigged and animated in Blender
(`blender/*.py`), and the courses are lit by photographed HDRI skies with CC0 photo textures.

## Run it

```bash
npm install
npm run dev        # http://localhost:5180
npm run build      # production build in dist/
```

## Features

- **Match play, stroke play or skins vs AI**, over the front 9, back 9 or all 18. Live status
  (`2 UP`, `DORMIE`, `3 & 2`; `+1 · LEAD BY 2`; `SKINS 3-1 · 2 ON THE LINE`), honours, gimmes,
  picking up, stroke-and-distance for out of bounds and penalty drops for water. On Easy, the first
  ball in water or out of bounds on each hole is a free mulligan.
- **Career mode:** eight events from the Club Championship to the Legends Final, each with a fixed
  opponent and an XP purse; win one to unlock the next.
- **Practice:** no opponent, play any hole as often as you like, drop a ball on the green to
  practise putting.
- **Swing styles:** Classic Tour, Power Bomber, Smooth Tempo, Precision Fader, Natural Draw and
  Short-Game Wizard change distance, accuracy, launch, spin, natural curve, the timing window and
  how the swing looks. AI opponents have personalities (Bomber, Grinder, Magician…) built on them.
- **Weather:** fair, breezy, overcast or rain (falling rain, softer greens, slower roll); Pebble
  Beach plays in low, warm late-afternoon light.
- **Putting:** realistic cup capture (pace and line decide lip-outs), a real hole cut in the green
  with the Blender cup liner, the ball dropping in, a TV-style cup camera, break readout, and ball
  markers on the green.
- **Divots and pitch marks** (Blender-modelled scar and flying turf), shot replay, visible ball
  spin, spin control (backspin / topspin), crowd reactions and course ambience (surf, wind, birds).
- **Four courses based on real 18-hole layouts:** Shinnecock Hills, Wykagyl Country Club, Pebble Beach
  and the Old Course at St Andrews. Real pars and yardages (Wykagyl's back nine is approximate); terrain, hazards, green contours and
  tree lines are generated from per-hole hints (doglegs, elevation, ponds, burns, ocean cliffs, pot
  bunkers, fescue).
- **Difficulty: Easy / Medium / Hard.** Changes the swing timing windows, how much of the shot and
  putt preview you get, and the AI opponent's skill and equipment.
- **Mouse swing timing.** *Swing Stick* (default, like 2K): hold the left button, pull the mouse
  down for the backswing, push it up through the start point. Tempo and straightness decide the
  strike. *3-Click* mode is available in Settings.
- **Club inventory** with arrow keys, **shot types** (Normal, Power, Draw, Fade, Punch, Pitch,
  Flop, Chip, Bump & Run), live **distance preview** (trajectory arc, landing ring, carry/total)
  and a power target on the swing meter.
- **Club-specific swing animations** (driver, woods/hybrids, irons, wedges, chips, putts).
- **Putting and green reading:** slope grid with downhill-flowing dots, elevation readout,
  putt preview line (full on Easy, partial on Medium, none on Hard), green-read camera.
- **Scoring:** strokes per hole for both players, par and score names (birdie, bogey…),
  scorecard (Tab).
- **Progression:** you start with *Rusty* clubs. Earn XP by winning matches, plus XP for every
  swing (tempo, straight path, fairways, greens, putts holed) and for holes won and birdies. The
  HUD shows your level, XP balance, the XP from your last swing and your total for the match.
  Upgrade each club through Clubhouse → Pro → Tour → Elite.
- **Text size:** Normal / Large (default) / Extra Large in Settings.
- **Player editor:** name, skin tone, hair style and colour, headwear, outfit colours,
  sunglasses, build and height.
- **Graphics:** HDRI sky lighting with a strong key sun, GPU-instanced grass blades (fescue, rough,
  first cut) generated in the vertex shader, procedural trees with photographic leaf cards and wind
  sway, card impostors for the surrounding woodland, a far landscape with forested hills and
  coastline out to the horizon, depth-tinted sea and ponds with surf, anti-aliased turf edges with
  grain-dependent mowing stripes, raked bunkers and revetted pot bunkers, triplanar cliff rock,
  ground-truth ambient occlusion and aerial-perspective haze.
- Single-player only; progress is saved in the browser's local storage.

## Controls

| Input | Action |
|---|---|
| Hold LMB, drag ↓ then push ↑ | Swing (Swing Stick mode) |
| Click ×3 | Swing (3-Click mode) |
| ← / → | Choose club |
| Q / E | Shot type |
| A / D (Shift = fine) | Aim |
| W / S or mouse wheel | Intended distance / power |
| V | Target camera |
| G | Green-read camera |
| R | Reset aim |
| C | Spin: Normal / Backspin / Topspin |
| P | Replay the last shot |
| Enter | Skip the opponent's shot |
| N / B | Practice: next hole / putting practice |
| Space | Skip flyover, hold to fast-forward the ball |
| Tab | Scorecard |
| Esc | Pause |

## Project layout

```
src/game      round controller, swing input, shot model, AI, match play, golfer, cameras
src/physics   ball flight / bounce / roll simulation
src/world     hole generator, terrain shader, vegetation, water, props, overlays, sky
src/ui        HUD and menus
src/data      courses and clubs
blender/      Blender scripts that build public/models/*.glb
public/assets CC0 HDRIs (Poly Haven) and textures (Poly Haven, ambientCG)
```

## Rebuilding the 3D assets

```bash
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup --python blender/build_golfer.py
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup --python blender/build_environment.py
```

## Credits

HDRI skies: Poly Haven (CC0). Textures: Poly Haven and ambientCG (CC0). Tree generator ported from
[ez-tree](https://github.com/dgreenheck/ez-tree) (MIT); bark and leaf textures credited in
`public/assets/trees/LICENSE.txt`. The golfer's head and face are built from the
[MakeHuman](https://github.com/makehumancommunity/makehuman) base mesh and targets (CC0), see
`blender/mh/SOURCE.md`. Course names refer to
real clubs for flavour only; layouts are approximations and not affiliated with or endorsed by
those clubs.

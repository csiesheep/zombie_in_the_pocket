// Rendering — reflects game + board state into the DOM. No game logic here.

import { RULES, effectiveAttack, clockTime, dread } from "./engine.js";
import { cellKey, currentTile, listMoves } from "./board.js";
import { combatSting, doorCreak, tollBell, breakThrough, itemPickup, footsteps, setDread,
         cardTurn, doorwayTick, duckForScare, wallThump, phantomScratch, shovel, heartbeat,
         muffle, passingSteps, cowerBreath, setScoreHour, buzz, isCalm,
         setSpace, wickHiss, setScoreRelief, splintering, startPounding, stopPounding,
         floodMurmur } from "./audio.js";

const DIR_CLASS = { N: "n", E: "e", S: "s", W: "w" };
const DIRS = ["N", "E", "S", "W"];
const DELTA = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const DIR_WORD = { N: "north", E: "east", S: "south", W: "west" };
const ARROW = { N: "↑", E: "→", S: "↓", W: "←" };
const ARROW_KEY = { ArrowUp: "N", ArrowRight: "E", ArrowDown: "S", ArrowLeft: "W" };

// The live choice set, whichever surface it is on. Board moves and window cards
// never coexist — renderActions routes to one or the other — and this asserts
// it rather than trusting it.
function currentChoices() {
  const doorways = [...document.querySelectorAll(".doorway")];
  const cards = [...document.querySelectorAll("#actions .action")];
  if (doorways.length && cards.length) {
    console.warn("Zombie in My Pocket: doorways and action cards on screen together");
  }
  return doorways.length ? doorways : cards;
}

// The three yard tiles are all "Lawn" and share one icon.
const ICON_ALIAS = { "yard-1": "yard", "yard-2": "yard", "yard-3": "yard" };
const SCENE_ALIAS = ICON_ALIAS;
// Scenes paint themselves rather than being drawn in currentColor (#62): they
// carry their own fills and end with a currentColor veil, so the world cast and
// the dusk dial still reach them. They must not be dimmed the way line art is,
// which is what the class is for.
//
// All fourteen are painted now. The check stays rather than being deleted: it
// is what a scene added later falls through, and falling through to the line-art
// treatment is the safe direction — a new drawing rendered faint is a smaller
// problem than a line drawing rendered at full opacity over the floor.
const SCENE_RICH = new Set([
  "foyer", "bathroom", "bedroom", "family-room", "dining-room", "storage",
  "kitchen", "evil-temple",
  "patio", "garage", "yard", "sitting-area", "garden", "graveyard",
]);

// Inject the icon sprite once, then reference symbols with <use href="#id">.
// External-file <use> references are not dependably supported, so the sprite is
// inlined instead. Icons are decorative: if the fetch fails, tiles fall back to
// their text label and nothing else changes.
export async function loadIcons() {
  try {
    const res = await fetch("assets/icons.svg", { cache: "no-cache" });
    if (!res.ok) return false;
    const holder = document.createElement("div");
    holder.hidden = true;
    holder.innerHTML = await res.text();
    document.body.appendChild(holder);
    return true;
  } catch {
    return false;
  }
}

// Exported for the tile gallery, which needs the same sprite handling.
export function icon(kind, id, cls) {
  const symbol = `${kind}-${ICON_ALIAS[id] || id}`;
  if (!document.getElementById(symbol)) return null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${symbol}`);
  svg.appendChild(use);
  return svg;
}

// Interface icons for anything outside the board — the sprite builder itself
// stays private.
export function uiIcon(name, cls) {
  return icon("ui", name, cls);
}

export function formatHour(hour) {
  return `${hour - 12} PM`;
}

// Same wording as formatHour, with the minutes the deck has spent. Midnight is
// the one that would read wrong as PM — and midnight is where this game ends,
// so it is worth getting right.
export function formatClock(c) {
  return `${c.label} ${c.hour24 >= 24 ? "AM" : "PM"}`;
}

// Health has no upper bound in this ruleset — cowering adds 3 with no cap — so
// there is no "x of y" to draw. Hearts show damage against the starting health
// while the number stays small, and fall back to a count once it does not.
const HEART_BASELINE = RULES.START_HEALTH;
const MAX_HEARTS = 10;

// Health, items and the hour are all diffed here rather than at the dozens of
// places that change them: renderHud sees every state refresh, so one hook
// catches damage from fights, flee costs and events alike.
let pendingMoves = [];
let movePrompt = "";
let lastHealth = null;
let lastItems = [];
const LOW_HEALTH = 2;

export function renderHud(game) {
  const health = game.state.health;
  if (lastHealth != null && health < lastHealth) damageFeedback();
  lastHealth = health;

  // One class; the pulse itself is CSS. Only while alive — the body should not
  // be beating under the you-died overlay.
  document.body.classList.toggle(
    "low-health",
    health > 0 && health <= LOW_HEALTH && game.state.status === "playing"
  );

  renderHealth(game.state);
  renderAttack(game.state);
  renderHour(game.state);
  renderRelic(game.state);

  // Which slots are new has to be worked out before the panel is rebuilt.
  const arrived = game.state.items.filter((id) => !lastItems.includes(id));
  lastItems = game.state.items.slice();
  renderBackpack(game);
  // The sound goes with the pickup, not with the animation — reduced motion
  // skips the flare, and a player who turned sound on still hears the find.
  for (const id of arrived) itemPickup(id);
  if (arrived.length) flourish(arrived);
}

// A new item announces itself: the slot pops and its icon flares gold. Nothing
// marks a loss — dropping and spending are quiet on purpose.
function flourish(arrived) {
  if (reducedMotion()) return;
  const rows = [...document.querySelectorAll("#hud-items .slot")];
  for (const id of arrived) {
    const row = rows.find((r) => {
      const use = r.querySelector("use");
      return use && use.getAttribute("href") === `#item-${id}`;
    });
    if (!row || typeof row.animate !== "function") continue;
    row.animate(
      [
        { transform: "scale(.9)", borderColor: "var(--gold)", boxShadow: "0 0 0 rgba(201,162,75,0)" },
        { transform: "scale(1.06)", borderColor: "var(--gold)", boxShadow: "0 0 18px rgba(201,162,75,.55)", offset: 0.35 },
        { transform: "scale(1)", borderColor: "var(--border)", boxShadow: "0 0 0 rgba(201,162,75,0)" },
      ],
      { duration: 620, easing: "cubic-bezier(.2,.8,.3,1)" }
    );
    const icon = row.querySelector(".itemicon");
    if (icon && typeof icon.animate === "function") {
      icon.animate(
        [{ transform: "scale(.8) rotate(-8deg)" }, { transform: "scale(1.18) rotate(4deg)", offset: 0.4 }, { transform: "scale(1) rotate(0)" }],
        { duration: 620, easing: "cubic-bezier(.2,.8,.3,1)" }
      );
    }
  }
}

// Icons are decorative; every stat carries its value as text for screen readers.
function srOnly(text) {
  const el = document.createElement("span");
  el.className = "sr-only";
  el.textContent = text;
  return el;
}

function statBox(id) {
  const el = document.getElementById(id);
  if (el) el.textContent = "";
  return el;
}

function renderHealth(s) {
  const el = statBox("hud-health");
  if (!el) return;

  if (s.health > MAX_HEARTS) {
    const heart = icon("stat", "heart", "staticon heart heart--full");
    if (heart) el.appendChild(heart);
    const n = document.createElement("span");
    n.className = "statnum";
    n.textContent = `×${s.health}`;
    n.setAttribute("aria-hidden", "true");
    el.appendChild(n);
  } else {
    const slots = Math.max(s.health, HEART_BASELINE);
    for (let i = 0; i < slots; i++) {
      const full = i < s.health;
      const heart = icon("stat", "heart", `staticon heart heart--${full ? "full" : "empty"}`);
      if (heart) el.appendChild(heart);
    }
  }
  el.appendChild(srOnly(String(s.health)));
}

function renderAttack(s) {
  const el = statBox("hud-attack");
  if (!el) return;
  const attack = effectiveAttack(s);
  const buffed = attack > RULES.START_ATTACK;

  const sword = icon("stat", "sword", "staticon sword" + (buffed ? " sword--buffed" : ""));
  if (sword) el.appendChild(sword);
  const n = document.createElement("span");
  n.className = "statnum" + (buffed ? " statnum--buffed" : "");
  n.textContent = String(attack);
  n.setAttribute("aria-hidden", "true");
  el.appendChild(n);
  el.appendChild(srOnly(buffed ? `${attack}, boosted by a weapon` : String(attack)));
}

// The hand sweeps round when the hour actually turns, which is the only time
// the clock changes — every other render redraws it in place.
let lastHour = null;
let lastReading = null;
let lastAngles = null;

function renderHour(s) {
  const el = statBox("hud-hour");
  if (!el) return;
  const c = clockTime(s);
  // The hour hand creeps between the marks rather than snapping, because the
  // hour really is draining the whole time — one card at a time.
  const hourAngle = ((c.hour24 % 12) + c.minutes / 60) * 30;
  const minuteAngle = c.minutes * 6;
  const face = clockFace(hourAngle, minuteAngle);
  el.appendChild(face);

  const reading = formatClock(c);
  const side = document.createElement("div");
  side.className = "clockread";
  side.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "statnum clocknum";
  text.textContent = reading;
  side.appendChild(text);
  side.appendChild(drawPips(c));
  el.appendChild(side);

  // Built from the same reading as the visible text, so the two cannot drift,
  // and carrying what the pips show — a hand position is not something to
  // announce as a shape.
  el.appendChild(srOnly(`${reading}, ${cardsLeftPhrase(c)}`));

  // The light now follows the minute hand, not the hour: one number out to CSS
  // and every dial in the light model moves with it, a sliver per card drawn.
  const body = document.body;
  const dusk = c.elapsed / c.span;
  body.style.setProperty("--dusk", dusk.toFixed(4));

  // Dusk is only the clock. Dread is the whole situation — how late, how hurt,
  // how bloody the hour has been, how little deck is left, whether you are
  // carrying the thing they want. Published alongside --dusk so CSS consumers
  // come free, and handed to the audio bed so wind and picture agree.
  const fear = dread(s);
  body.style.setProperty("--dread", fear.toFixed(4));
  setDread(fear);

  // The score thickens by an hour and then, at eleven, stops. Driven from the
  // same place the light and the wind are, so the three never disagree about
  // what time it is.
  setScoreHour(s.hour);
  // And falls back a layer while the room is letting go. Same dial, same
  // place: the light, the wind and the music are never told different things.
  setScoreRelief(s.relief || 0);

  // The hour class stays for the jobs a gradient cannot do — the last hour's
  // change of register, and strikeEleven keying off the turn. timePasses loses
  // at midnight before it can increment past 23, so 9/10/11 covers every state
  // a player can be looking at; the clamp is belt and braces.
  const hour = Math.min(Math.max(s.hour - 12, 9), 11);
  for (const h of [9, 10, 11]) body.classList.toggle(`hour-${h}`, h === hour);

  const turned = lastHour != null && lastHour !== s.hour;
  lastHour = s.hour;
  if (turned && s.hour === RULES.FINAL_HOUR) strikeEleven(face);

  // The clock's heartbeat is now the draw, not the hour: every card that leaves
  // the deck sweeps the hands. Diffing on the reading means a refresh that
  // changed nothing else does not re-animate.
  const moved = lastReading != null && lastReading !== c.label;
  const from = lastAngles;
  lastReading = c.label;
  lastAngles = { hour: hourAngle, minute: minuteAngle };
  if (!moved || !from || reducedMotion()) return;

  sweep(face.querySelector(".clock-hand--minute"), from.minute, minuteAngle);
  sweep(face.querySelector(".clock-hand--hour"), from.hour, hourAngle);
}

// Hands only ever go forwards. Crossing the top takes the minute hand from 306°
// to 0°, which as a plain interpolation would rewind the whole face.
function sweep(hand, from, to) {
  if (!hand || typeof hand.animate !== "function") return;
  const target = to < from ? to + 360 : to;
  hand.animate(
    [{ transform: `rotate(${from}deg)` }, { transform: `rotate(${target}deg)` }],
    { duration: 400, easing: "cubic-bezier(.3,.8,.4,1)" }
  );
}

// The deck as a fuel gauge: seven pips, one going out per card spent. The issue
// asked for these around the current hour's arc; measured at the face size it
// specifies, seven pips across 30 degrees is 17px of arc end to end, which is
// not a gauge anyone can read. A row beside the reading shows the same fact at
// a size that survives.
function drawPips(c) {
  const row = document.createElement("span");
  row.className = "pips";
  for (let i = 0; i < c.perHour; i++) {
    const pip = document.createElement("span");
    // Pips stand for draws still available, so they go out left to right.
    pip.className = `pip${i < c.left ? "" : " pip--spent"}`;
    row.appendChild(pip);
  }
  return row;
}

function cardsLeftPhrase(c) {
  if (c.left === 0) return "the next card turns the hour";
  return `${c.left} card${c.left === 1 ? "" : "s"} until the hour turns`;
}

// The last hour, called out. The ambient palette shift is handled by the hour
// class; this is the punctuation on top of it.
function strikeEleven(face) {
  const line = "Eleven. The last hour — when the deck runs dry, it is midnight.";
  log(line, "bad");
  // The one line the issue insists must stay visible, and rightly: it is the
  // moment the game tells you how it ends.
  caption(line, "toll");
  tollBell();
  if (reducedMotion() || typeof face.animate !== "function") return;
  face.animate(
    [
      { transform: "rotate(0deg) scale(1)" },
      { transform: "rotate(-9deg) scale(1.18)", offset: 0.25 },
      { transform: "rotate(8deg) scale(1.14)", offset: 0.55 },
      { transform: "rotate(-3deg) scale(1.06)", offset: 0.8 },
      { transform: "rotate(0deg) scale(1)" },
    ],
    { duration: 900, easing: "ease-in-out" }
  );
}

// Drawn on a 100-unit face rather than 24: at a readable size the old viewBox
// put stroke widths and numerals on a grid too coarse to place them well.
//
// Only the 9-to-12 quadrant is ever played, so it is marked like a gauge:
// numerals on the hours that exist, and the last hour's arc in --danger.
const CLOCK_R = 40;
const NUMERAL_R = 23;
const PLAYED_HOURS = [9, 10, 11, 12];

function polar(deg, r) {
  const rad = (deg * Math.PI) / 180;
  return [50 + r * Math.sin(rad), 50 - r * Math.cos(rad)];
}

function clockFace(hourAngle, minuteAngle = 0) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "clock");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("aria-hidden", "true");

  const face = document.createElementNS(NS, "circle");
  face.setAttribute("cx", "50");
  face.setAttribute("cy", "50");
  face.setAttribute("r", String(CLOCK_R));
  face.setAttribute("class", "clock-face");
  svg.appendChild(face);

  // The red zone: eleven to midnight, the hour the game ends in.
  const [ax, ay] = polar(330, CLOCK_R);
  const [bx, by] = polar(360, CLOCK_R);
  const arc = document.createElementNS(NS, "path");
  arc.setAttribute("d", `M${ax.toFixed(2)} ${ay.toFixed(2)} A${CLOCK_R} ${CLOCK_R} 0 0 1 ${bx.toFixed(2)} ${by.toFixed(2)}`);
  arc.setAttribute("class", "clock-danger");
  svg.appendChild(arc);

  for (let h = 0; h < 12; h++) {
    const deg = h * 30;
    const played = PLAYED_HOURS.includes(h === 0 ? 12 : h);
    const [x1, y1] = polar(deg, CLOCK_R);
    const [x2, y2] = polar(deg, played ? CLOCK_R - 5 : CLOCK_R - 3);
    const tick = document.createElementNS(NS, "line");
    tick.setAttribute("x1", x1.toFixed(2));
    tick.setAttribute("y1", y1.toFixed(2));
    tick.setAttribute("x2", x2.toFixed(2));
    tick.setAttribute("y2", y2.toFixed(2));
    tick.setAttribute("class", `clock-tick${played ? " clock-tick--played" : ""}`);
    svg.appendChild(tick);
  }

  for (const h of PLAYED_HOURS) {
    const [x, y] = polar((h % 12) * 30, NUMERAL_R);
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", x.toFixed(2));
    t.setAttribute("y", y.toFixed(2));
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("dominant-baseline", "central");
    t.setAttribute("class", `clock-numeral${h === 12 ? " clock-numeral--midnight" : ""}`);
    t.textContent = String(h);
    svg.appendChild(t);
  }

  svg.appendChild(hand(NS, "minute", 27, minuteAngle));
  svg.appendChild(hand(NS, "hour", 18, hourAngle));

  const pin = document.createElementNS(NS, "circle");
  pin.setAttribute("cx", "50");
  pin.setAttribute("cy", "50");
  pin.setAttribute("r", "2");
  pin.setAttribute("class", "clock-pin");
  svg.appendChild(pin);

  return svg;
}

function hand(NS, kind, length, angle) {
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", "50");
  line.setAttribute("y1", "50");
  line.setAttribute("x2", "50");
  line.setAttribute("y2", String(50 - length));
  line.setAttribute("class", `clock-hand clock-hand--${kind}`);
  line.style.transformOrigin = "50px 50px";
  line.style.transform = `rotate(${angle}deg)`;
  return line;
}

function renderRelic(s) {
  const el = statBox("hud-totem");
  if (!el) return;
  if (s.totem) {
    const art = icon("tile", "graveyard", "staticon relic relic--held");
    if (art) el.appendChild(art);
  }
  const text = document.createElement("span");
  text.className = "statnum" + (s.totem ? " statnum--buffed" : "");
  text.textContent = s.totem ? "Held" : "Not yet";
  text.setAttribute("aria-hidden", "true");
  el.appendChild(text);
  el.appendChild(srOnly(s.totem ? "held" : "not found yet"));
}

// The backpack: one row per carry slot, empty ones included so the two-item
// limit is visible rather than implied. Effects are derived from items.json, so
// a re-theme or a stat change needs no edit here.
function renderBackpack(game) {
  const s = game.state;
  const el = document.getElementById("hud-items");
  if (!el) return;
  el.textContent = "";

  for (let i = 0; i < RULES.MAX_ITEMS; i++) {
    const id = s.items[i];
    const row = document.createElement("div");
    row.className = "slot" + (id ? "" : " slot--empty");

    if (!id) {
      const name = document.createElement("span");
      name.className = "slotname";
      name.textContent = "Empty slot";
      row.appendChild(name);
      el.appendChild(row);
      continue;
    }

    const art = icon("item", id, "itemicon");
    if (art) row.appendChild(art);

    const text = document.createElement("span");
    text.className = "slottext";
    const name = document.createElement("span");
    name.className = "slotname";
    name.textContent = itemName(game, id);
    text.appendChild(name);

    const effect = itemEffect(game, id);
    if (effect) {
      const eff = document.createElement("span");
      eff.className = "sloteffect";
      eff.textContent = effect;
      text.appendChild(eff);
    }
    row.appendChild(text);
    el.appendChild(row);
  }

}

function itemEffect(game, id) {
  const it = game.state.itemsById[id];
  if (!it) return "";
  if (it.type === "weapon") {
    const fuel = it.fuel != null ? ` · ${game.state.chainsawFuel} fight${game.state.chainsawFuel === 1 ? "" : "s"} of fuel` : "";
    return `+${it.attack} attack${fuel}`;
  }
  if (it.type === "heal") return `+${it.health} health`;
  const bits = [];
  if (it.fleeNoDamage) bits.push("flee unharmed");
  if (it.combo) bits.push("pairs with " + Object.keys(it.combo).map((k) => itemName(game, k)).join(" or "));
  if (it.type === "enabler") bits.push("needs a fuel to use");
  return bits.join(" · ");
}

// What each wall of the room you're standing in is currently doing. Passability
// is taken from listMoves() rather than re-derived, so the picture can never
// disagree with the buttons.
//
// Five states, because this ruleset allows a door to open onto a neighbour's
// blank wall:
//   wall     — no opening at all
//   shut     — an opening with unexplored space beyond; nothing to show behind it
//   open     — a passage into an explored room; that room is shown, half-seen
//   blocked  — an opening that leads nowhere (a door facing a wall, or no tiles
//              left to place). Drawn shut, because you cannot use it.
//   outside  — the arrow door, before the seam is placed
function edgeStates(game) {
  const board = game.board;
  const tile = currentTile(board);
  // A seam "cross" move shares its direction with the arrow door, and is pushed
  // after the per-direction moves, so it legitimately wins here.
  const byDir = new Map(listMoves(board).map((m) => [m.dir, m]));

  const out = {};
  for (const dir of DIRS) {
    const hole = tile.holes.includes(dir);
    const door = tile.exits.includes(dir);
    const move = byDir.get(dir);
    const type = move && move.type;

    // The arrow edge is a passage that is not one of the tile's own doors: the
    // Veranda joins the house along its seam edge, which is absent from its
    // exit list. Without this the way home renders as blank wall.
    const arrow = dir === tile.exteriorDir || dir === tile.seamDir;

    if (!hole && !door && !arrow) {
      out[dir] = { kind: "wall", state: "wall", neighbour: null };
      continue;
    }

    let state = "blocked";
    let neighbour = null;

    if (type === "move" || type === "cross") {
      state = "open";
      const to = move.to;
      neighbour = board.worlds[to.world].get(cellKey(to.x, to.y)) || null;
    } else if (type === "outside") {
      state = "outside";
    } else if (type === "explore") {
      state = "shut";
    } else {
      // No move offered. Either a door onto an explored neighbour's wall, or an
      // unexplored edge with an empty tile stack.
      const [dx, dy] = DELTA[dir];
      state = board.worlds[tile.world].get(cellKey(tile.x + dx, tile.y + dy)) ? "blocked" : "shut";
    }

    out[dir] = {
      kind: hole ? "broken" : "door",
      arrow,
      crossesWorld: type === "cross",
      state,
      neighbour,
    };
  }
  return out;
}

// Only the room you're in, centred, with a half-glimpse of each explored room
// you could step into. Nothing behind a shut door.
export function renderBoard(game) {
  const board = game.board;
  const el = document.getElementById("board");

  // Belt and braces alongside the ResizeObserver: a pane can change size for
  // reasons no observer notification reliably lands for, and a board rendered
  // at a stale tile size is very visible. fitBoard early-returns when nothing
  // moved, so this costs one clientWidth read per render.
  fitBoard();

  // Read before the wipe: clearing the board destroys the focused hotspot and
  // drops focus to <body>, which would strand a keyboard player mid-turn.
  const active = document.activeElement;
  const focusedDir =
    active && active.classList && active.classList.contains("doorway") ? active.dataset.dir : null;

  el.innerHTML = "";

  const tile = currentTile(board);
  const edges = edgeStates(game);

  // Which half of the map you are standing in, carried on the board so the cast
  // reaches floors, walls and all fourteen scenes from one place.
  el.classList.toggle("board--indoor", board.player.world === "indoor");
  el.classList.toggle("board--outdoor", board.player.world === "outdoor");
  // The same fact told to the ear: inside is a small dark room, outside is
  // distance. Sent from here rather than from the seam crossing so that a
  // reload, a new game and the first render all land in the right space —
  // seamCross() only fires on the one move that changes world.
  setSpace(board.player.world);
  const pane = el.closest(".board-pane");
  if (pane) {
    pane.classList.toggle("pane--indoor", board.player.world === "indoor");
    pane.classList.toggle("pane--outdoor", board.player.world === "outdoor");
  }

  const view = document.createElement("div");
  view.className = "focus";

  for (const dir of DIRS) {
    const e = edges[dir];
    const slot = document.createElement("div");
    slot.className = `focus-slot focus-slot--${DIR_CLASS[dir]}`;
    if (e.state === "open" && e.neighbour) slot.appendChild(halfRoom(game, e, dir));
    // A way out with nothing placed behind it yet: the only dark on this board
    // that is a doorway rather than a wall. Marked here because this is where
    // the edge is known, and read by standing() much later.
    else if (e.kind !== "wall") slot.dataset.unopened = "";
    view.appendChild(slot);
  }

  const centre = document.createElement("div");
  centre.className = "focus-centre";
  centre.appendChild(centreRoom(game, tile, edges));
  view.appendChild(centre);

  el.appendChild(view);

  // renderBoard rebuilds .focus from scratch, so hotspots cannot be attached
  // once and kept — they are re-applied from the pending list every rebuild.
  // A wall that is mid-failure has no board state to be rebuilt from, so the
  // sequence puts its art back rather than losing it to a refresh.
  restoreBreachWall();

  if (pendingMoves.length) {
    mountDoorways(el);
    // Put focus back on the same doorway. `focusedDir` was read before the wipe
    // below cleared the board — by this point activeElement is already <body>.
    if (focusedDir) {
      const again = el.querySelector(`.doorway[data-dir="${focusedDir}"]`);
      if (again) again.focus();
    }
  }
}

// Movement choices, drawn on the doorways they refer to. Real buttons in
// N/E/S/W order inside a labelled group, so the spoken experience matches what
// the panel used to give.
function clearDoorways() {
  for (const g of document.querySelectorAll(".doorways")) g.remove();
}

function mountDoorways(boardEl) {
  const box = boardEl.querySelector(".focus-centre .tilebox");
  if (!box) return;

  const group = document.createElement("div");
  group.className = "doorways";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", movePrompt || "Choose a way out");

  for (const dir of DIRS) {
    const move = pendingMoves.find((m) => m.dir === dir);
    if (!move) continue;
    const hot = document.createElement("button");
    hot.type = "button";
    hot.className = `doorway ${DIR_CLASS[dir]}` + (move.primary ? " doorway--explore" : "");
    hot.dataset.dir = dir;
    hot.dataset.kind = "move";
    // The accessible name stays the full old label, so nothing regressed for a
    // screen reader when this moved off the panel.
    hot.setAttribute("aria-label", move.label);
    // The number chip is absolutely positioned into the button's corner, so it
    // stays a direct child and out of the flex flow.
    const n = pendingMoves.indexOf(move);
    if (n < 9) {
      const k = document.createElement("kbd");
      k.textContent = String(n + 1);
      k.setAttribute("aria-hidden", "true");
      hot.appendChild(k);
    }
    if (move.primary) {
      const face = document.createElement("span");
      face.className = "doorway-face";
      face.setAttribute("aria-hidden", "true");
      face.textContent = "?";
      hot.appendChild(face);
    }

    // The arrow points the way out. Explored neighbours get it on its own —
    // the glimpse through the door already says which room is there. Unexplored
    // ways keep the "?" beside it: an arrow into the dark.
    const arrow = document.createElement("span");
    arrow.className = "doorway-arrow";
    arrow.setAttribute("aria-hidden", "true");
    const chev = icon("ui", "chevron", "doorway-chev");
    if (chev) arrow.appendChild(chev);
    else arrow.textContent = ARROW[dir]; // no sprite: the text arrow still points
    // First child, so the flex direction can put it on the outward side.
    hot.insertBefore(arrow, hot.firstChild);

    hot.addEventListener("click", move.onClick);
    // Focus, not hover: a tick every time the pointer crosses a door would be
    // a fly in the room rather than an affordance.
    hot.addEventListener("focus", doorwayTick);
    group.appendChild(hot);
  }
  box.appendChild(group);
}

// ---- The scare -------------------------------------------------------------
// A full-window flash of the risen before the combat choices appear. Unlike
// animateEntry this one is *awaited* — the actions land after the fade — so it
// has to resolve in every circumstance or the turn would stall: no art, no
// Web Animations, reduced motion, all resolve immediately.
//
// The caller clears the action list before calling this, so during the flash
// there are no buttons to click and none for the global number keys to find.
// That is what stops a player mashing 1 from firing whatever appears
// underneath.
const SCARE_BASE_MS = 300;

// Where each of the risen stands, in order. One face for the smallest pack, up
// to six, so a three-zombie dead end and a six-zombie card do not land
// identically. Fixed rather than random: a seeded run is meant to replay the
// same, and Math.random here would make the same fight look different twice.
// [x%, y%, scale, share of the run before it appears]
const SCARE_SLOTS = [
  [50, 50, 1.0, 0.0],
  [21, 38, 0.62, 0.1],
  [79, 43, 0.66, 0.16],
  [33, 74, 0.54, 0.22],
  [69, 76, 0.58, 0.28],
  [50, 21, 0.5, 0.34],
];

// Where they come from, when the game knows. A card fight is a pack that is
// simply there and gets the centred burst it always had; a break-in came
// through a particular wall, and the difference between "they are here" and
// "they came through THERE" is the entire reason this exists.
//
// The slots stay exactly where they were — same fixed positions, same
// determinism — and the direction is one extra transform axis on the way in:
// the faces enter from that edge of the screen rather than scaling up in place.
const SCARE_ENTRY = {
  N: [0, -34],
  S: [0, 34],
  E: [38, 0],
  W: [-38, 0],
};

export function jumpScare(count = 0, silent = false, opts = {}) {
  // Calm keeps the sting and the pack row; the face does not arrive.
  if (isCalm()) silent = true;
  const from = SCARE_ENTRY[opts.from] ? opts.from : null;
  // The room goes quiet first. duckForScare returns how long to wait — and
  // returns 0 when there is nothing audible to take away, so a muted player
  // waits for nothing at all. A silence nobody can hear is just a delay.
  const quiet = duckForScare();
  const fire = () => (silent ? stingOnly(count, from) : scareNow(count, from));
  if (quiet > 0) {
    return new Promise((resolve) => {
      setTimeout(() => fire().then(resolve), quiet);
    });
  }
  return fire();
}

// The scare that does not arrive: the sting lands, the room stays quiet, and
// the window simply opens on a pack that is already there. Same shape and
// roughly the same length as the real one, because the gating that keeps a
// mashed key from finding anything depends on this taking time too.
function stingOnly(count, from = null) {
  return new Promise((resolve) => {
    // A silent directional scare is just the panned sting — which is the whole
    // of it in calm mode too, where the sound carries the direction because
    // audio is not motion.
    combatSting(count, from);
    buzz([18, 40, 18]);
    setTimeout(resolve, reducedMotion() ? 0 : 420);
  });
}

function scareNow(count, from = null) {
  return new Promise((resolve) => {
    enterScene();
    const endScene = () => leaveScene();
    // Same rule as the door: the cue is sound, not motion, so it plays whether
    // or not the picture does.
    combatSting(count, from);
    buzz([26, 50, 90]);
    if (reducedMotion()) { endScene(); return resolve(); }

    // A card fight can be followed straight away by a zombie door; never stack.
    const stale = document.querySelector(".scare");
    if (stale) stale.remove();

    if (!document.getElementById("scare-zombie")) { endScene(); return resolve(); } // no art, no hold-up

    const el = document.createElement("div");
    el.className = "scare";
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);

    if (typeof el.animate !== "function") {
      el.remove();
      endScene();
      return resolve();
    }

    // Encounters run 3 to 6, so weight across that band rather than from zero.
    const faces = Math.max(1, Math.min(count || 1, SCARE_SLOTS.length));
    const weight = Math.min(Math.max((faces - 3) / 3, 0), 1);
    const duration = SCARE_BASE_MS + Math.round(weight * 200);

    for (let i = 0; i < faces; i++) {
      const [x, y, scale, at] = SCARE_SLOTS[i];
      const art = icon("scare", "zombie", "scare-art");
      if (!art) break;
      const seat = document.createElement("span");
      seat.className = "scare-face";
      seat.style.left = `${x}%`;
      seat.style.top = `${y}%`;
      seat.style.setProperty("--face-scale", String(scale));
      seat.appendChild(art);
      el.appendChild(seat);

      // The one in front lunges; the pack behind snaps in after it. The size
      // itself comes from --face-scale on the width, so these keyframes are a
      // relative nudge around it — multiplying by `scale` here would apply it
      // twice and leave the back row far smaller than intended.
      //
      // With a direction, they arrive from that edge instead: the same landing
      // positions, entered from off-screen on the side the wall is failing. The
      // one in front still comes in largest — it is nearest, and coming through
      // first.
      const [ex, ey] = from ? SCARE_ENTRY[from] : [0, 0];
      const lead = i ? 0.8 : 1.2;
      const enterFrom = from
        ? `translate(calc(-50% + ${ex}vw), calc(-50% + ${ey}vh)) scale(${lead})`
        : `translate(-50%, -50%) scale(${lead})`;
      seat.animate(
        [
          { opacity: 0, transform: enterFrom },
          { opacity: 1, transform: "translate(-50%, -50%) scale(1)" },
        ],
        { duration: Math.round(duration * 0.34), delay: Math.round(duration * at), fill: "backwards", easing: "cubic-bezier(.2,.8,.3,1)" }
      );
    }

    const anim = el.animate(
      [
        { opacity: 0 },
        { opacity: 1, offset: 0.16 },
        { opacity: 1, offset: 0.66 },
        { opacity: 0 },
      ],
      { duration, easing: "ease-out" }
    );
    // Resolve once, from whichever comes first. Web Animations do not advance
    // while the document is hidden, so anim.finished hangs for as long as the
    // player has the tab in the background — and the combat choices are gated
    // behind this promise, which would leave the turn frozen on their return.
    // Timers still fire when backgrounded, so one backs the animation up.
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      el.remove();
      endScene();
      resolve();
    };
    anim.finished.then(done).catch(done);
    setTimeout(done, duration + 250);
  });
}

// ---- Sizing the board off the pane, not the viewport ------------------------
// --tile keyed on 19vh, which never saw how wide the column actually was: the
// map stayed the same size whether it had 300px of room or 900px. These
// constants mirror the CSS geometry — the focus is peek + tile + peek across
// with a gap either side — so the tile can be solved from the space available.
const FOCUS_SPAN = 1.84; // peek(.42) + tile(1) + peek(.42), in tiles
const GAP_RATIO = 0.13; // --tile-gap once it is off its floor
const GAP_FLOOR = 18; // px, the floor itself
const BOARD_FILL = 0.88; // how much of the pane's short side the focus claims
const TILE_MIN = 96;
const TILE_MAX = 320;
// Below this the layout is one column and the pane's height comes from its own
// content — measuring it there would feed the tile back into its own budget.
const TWO_COLUMN = "(min-width: 801px)";

export function fitBoard() {
  const pane = document.querySelector(".board-pane");
  if (!pane) return;

  const root = document.documentElement;
  if (!window.matchMedia || !window.matchMedia(TWO_COLUMN).matches) {
    // Stacked, there is nothing safe to measure: the pane's height comes from
    // its own content, so reading it would feed the tile back into its own
    // budget. And it would not help anyway — with the board above the sidebar
    // it is the sidebar that runs out of room first, not the board. Hand the
    // size back to the CSS clamp, which is what this layout has always used.
    root.style.removeProperty("--tile");
    return;
  }

  // Two columns: both axes are safe. The column is minmax(0, 1fr) so it bounds
  // the board rather than the board setting it, and the row is stretched to a
  // definite height.
  const budget = BOARD_FILL * Math.min(pane.clientWidth, pane.clientHeight);
  if (!(budget > 0)) return;

  // Two regimes, because the gap scales with the tile until it hits its floor.
  let tile = budget / (FOCUS_SPAN + 2 * GAP_RATIO);
  if (tile * GAP_RATIO < GAP_FLOOR) tile = (budget - 2 * GAP_FLOOR) / FOCUS_SPAN;
  tile = Math.max(TILE_MIN, Math.min(TILE_MAX, Math.round(tile)));

  if (root.style.getPropertyValue("--tile") === `${tile}px`) return; // no-op writes churn layout
  root.style.setProperty("--tile", `${tile}px`);
}

export function watchBoardSize() {
  fitBoard();
  const pane = document.querySelector(".board-pane");
  if (pane && typeof ResizeObserver === "function") {
    // The pane changes size for reasons the window does not see — the sidebar
    // growing, the layout switching columns — so observe it rather than resize.
    new ResizeObserver(() => fitBoard()).observe(pane);
  }
  window.addEventListener("resize", fitBoard);
}

// Take the choices away without taking the window with them. renderActions([])
// hides the whole pop, which would take the pack row down with it — and the
// pack row is the stage the resolution beat plays on.
export function clearChoices() {
  pushIn(false);
  const el = document.getElementById("actions");
  if (el) el.innerHTML = "";
  pendingMoves = [];
  movePrompt = "";
  clearDoorways();
}

const BEAT_MS = 600;
const FLEE_BEAT_MS = 240;

// Cause, then effect: the weapon crosses the row, and the pack goes down behind
// it. The engine has already resolved by the time this runs — this only holds
// the next render back long enough for the player to see why the number moved.
export function resolveBeat(opts = {}) {
  return new Promise((resolve) => {
    const row = document.querySelector(".packrow");
    const figs = row ? [...row.querySelectorAll(".packfig")] : [];
    // No art, no Web Animations, no motion budget — every one of these skips
    // straight to the outcome rather than stranding the turn.
    if (reducedMotion() || !figs.length || typeof figs[0].animate !== "function") {
      return resolve();
    }

    const flee = opts.mode === "flee";
    const duration = flee ? FLEE_BEAT_MS : BEAT_MS;
    let swing = null;

    if (flee) {
      // They lunge and miss. That is the whole story, and it is 240ms long.
      figs.forEach((f, i) => {
        f.animate(
          [
            { transform: "translateY(0) scale(1)", opacity: 0.9 },
            { transform: "translateY(-6px) scale(1.16)", opacity: 1, offset: 0.45 },
            { transform: "translateY(0) scale(1)", opacity: 0.9 },
          ],
          { duration, delay: i * 14, easing: "ease-out" }
        );
      });
    } else {
      swing = opts.icon ? swingArt(row, opts.icon) : null;
      if (swing) {
        swing.animate(
          [
            { transform: "translate(-40%, -50%) rotate(-46deg)", opacity: 0 },
            { transform: "translate(20%, -50%) rotate(-12deg)", opacity: 1, offset: 0.3 },
            { transform: "translate(120%, -50%) rotate(38deg)", opacity: 1, offset: 0.8 },
            { transform: "translate(150%, -50%) rotate(52deg)", opacity: 0 },
          ],
          { duration: Math.round(duration * 0.62), easing: "cubic-bezier(.3,.1,.2,1)" }
        );
      }
      // Staggered left to right so the blade appears to be what fells them.
      // No per-zombie HP fiction here: the ruleset clears the pack outright, so
      // the row simply empties.
      figs.forEach((f, i) => {
        const lead = figs.length > 1 ? i / (figs.length - 1) : 0;
        f.animate(
          [
            { transform: "translateY(0) rotate(0)", opacity: 0.9 },
            { transform: "translateY(3px) rotate(6deg)", opacity: 0.9, offset: 0.25 },
            { transform: "translateY(26px) rotate(74deg)", opacity: 0 },
          ],
          {
            duration: Math.round(duration * 0.5),
            delay: Math.round(duration * 0.24 + lead * duration * 0.24),
            fill: "forwards",
            easing: "cubic-bezier(.4,0,.7,.4)",
          }
        );
      });
    }

    // Same gate as the jump scare, and for the same reason: animations do not
    // advance while the tab is hidden, so a timer has to be able to finish the
    // beat on its own or the turn never resumes.
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      // The swing has no forwards fill, so leaving it mounted would snap the
      // weapon back to full opacity and park it over the row until the next
      // render replaces the head.
      if (swing) swing.remove();
      resolve();
    };
    setTimeout(done, duration + 60);
  });
}

function swingArt(row, iconId) {
  const cut = iconId.indexOf("-");
  if (cut <= 0) return null;
  const art = icon(iconId.slice(0, cut), iconId.slice(cut + 1), "swingart");
  if (!art) return null;
  row.appendChild(art);
  return art;
}

// ---- Cowering, from the inside -----------------------------------------------
// Mechanically this is hiding in a corner for a slice of an hour while things
// walk past. It used to be a button and a log line.
//
// So: the view narrows to a slit, the house goes muffled, the breathing is the
// only thing still close, and one set of footsteps passes a wall you are not on
// the other side of. Then the slit opens and the health lands with the exhale.
//
// Presentation only — E.cower has already resolved and the card is already
// spent. Reduced motion keeps the whole audio treatment and drops the squint,
// because the muffle is what actually says "hiding" and the vignette only
// illustrates it.
const COWER_MS = 1500;

export function cowerScene(outdoors = false) {
  return new Promise((resolve) => {
    cowerBreath();
    muffle(true, 0.28);
    // Something goes past while you are down there. Late enough that the
    // muffle has closed first, so it arrives already distant.
    setTimeout(() => passingSteps(outdoors ? "outdoor" : "indoor"), 420);

    const open = () => {
      muffle(false, 0.6);
      document.body.classList.remove("cowering");
    };

    if (reducedMotion()) {
      setTimeout(() => { open(); resolve(); }, COWER_MS);
      return;
    }

    document.body.classList.add("cowering");
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      open();
      resolve();
    };
    // Timer-backed like every other awaited beat: a hidden tab advances no
    // animation, and the turn cannot be allowed to hang on one.
    setTimeout(done, COWER_MS);
  });
}

// ---- The burial --------------------------------------------------------------
// The climax used to resolve like any other card: draw, verdict. This wraps the
// draw the way the scare wraps combat — presentation only, the engine untouched
// underneath, and it hands back in every circumstance.
//
// The Family Plot gets the full weight and the Reliquary a lighter version of
// the same shape. Both are the same beat; only the count and the tightening
// differ, because one is finding the thing and the other is finishing.
const DIG_CUTS = { graveyard: 3, temple: 2 };
const DIG_GAP_MS = 640;

export function buryBeat(kind = "graveyard") {
  const full = kind === "graveyard";
  const cuts = DIG_CUTS[kind] || 2;

  return new Promise((resolve) => {
    // The cues play even when the picture does not — the same rule the door and
    // the wall follow.
    if (reducedMotion()) {
      for (let i = 0; i < cuts; i++) setTimeout(shovel, i * DIG_GAP_MS);
      return resolve();
    }

    enterScene();
    if (full) document.body.classList.add("burying");

    const box = document.querySelector(".focus-centre .tilebox");
    const hole = document.createElement("span");
    hole.className = "grave";
    hole.setAttribute("aria-hidden", "true");
    if (box) box.appendChild(hole);

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      hole.remove();
      document.body.classList.remove("burying");
      leaveScene();
      resolve();
    };

    // Each cut deepens the ground a step, with the heart under it. Fixed
    // rhythm rather than a random one: this is the same grave every time.
    for (let i = 0; i < cuts; i++) {
      setTimeout(() => {
        shovel();
        heartbeat(full ? 1 : 0.7);
        hole.style.setProperty("--depth", String((i + 1) / cuts));
      }, i * DIG_GAP_MS);
    }
    // Timer-backed, like every awaited beat here: a hidden tab advances no
    // animations and the turn must never hang on one.
    setTimeout(done, cuts * DIG_GAP_MS + 420);
  });
}

// ---- The note in the hall ----------------------------------------------------
// A new player used to learn this game by leaving it — a link to the rulebook,
// read in a browser tab, before any of the atmosphere had started. Horror
// teaches inside the fiction, so the fiction teaches: a folded letter on the
// hall table from whoever sent you.
//
// It says only the three things that decide a run — what you are looking for,
// where it goes, and that the deck is the clock. The rulebook is still the
// reference; this is only the hook.
//
// Real text in a real dialog, not a picture of a letter: a screen reader gets
// exactly what everyone else gets.
export function showNote(note, onClose) {
  const wrap = document.createElement("div");
  wrap.className = "notecard";
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-modal", "true");
  wrap.setAttribute("aria-labelledby", "note-title");

  const sheet = document.createElement("div");
  sheet.className = "notesheet";

  const h = document.createElement("h2");
  h.id = "note-title";
  h.textContent = note.title;
  sheet.appendChild(h);

  for (const line of note.lines) {
    const p = document.createElement("p");
    p.textContent = line;
    sheet.appendChild(p);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn--primary notedismiss";
  close.textContent = note.dismiss;
  sheet.appendChild(close);
  wrap.appendChild(sheet);
  document.body.appendChild(wrap);

  const done = () => {
    if (!wrap.isConnected) return;
    wrap.remove();
    document.removeEventListener("keydown", onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    // Escape closes it, because a dialog that traps you is a worse first
    // impression than no dialog at all.
    if (e.key === "Escape") done();
  };
  close.addEventListener("click", done);
  document.addEventListener("keydown", onKey);
  close.focus();
  return done;
}

// ---- Film stock --------------------------------------------------------------
// Grain and dust, mounted once into the board pane and then left alone. Both
// are decoration in the strictest sense: aria-hidden, pointer-events none, and
// nothing in the game ever reads them.
//
// Fixed mote positions rather than random ones, the same house rule the wall
// dust and the scare faces follow — a shared seed should look the same twice,
// and dust that reshuffles on every render reads as a glitch.
const MOTES = [
  // [x%, y%, drift x, drift y, seconds, delay]
  [38, 62, 22, -52, 15, 0],
  [55, 70, -18, -60, 19, 2.5],
  [46, 55, 30, -40, 13, 6],
  [62, 58, -26, -48, 17, 9],
  [44, 72, 14, -66, 21, 12],
  [58, 48, -20, -34, 16, 4.5],
];

export function mountFilmStock() {
  const pane = document.querySelector(".board-pane");
  if (!pane || pane.querySelector(".grain")) return;

  const grain = document.createElement("div");
  grain.className = "grain";
  grain.setAttribute("aria-hidden", "true");
  pane.appendChild(grain);

  if (reducedMotion()) return; // grain holds a frame; dust does not belong at all

  const motes = document.createElement("div");
  motes.className = "motes";
  motes.setAttribute("aria-hidden", "true");
  for (const [x, y, dx, dy, dur, delay] of MOTES) {
    const m = document.createElement("i");
    m.style.setProperty("--x", `${x}%`);
    m.style.setProperty("--y", `${y}%`);
    m.style.setProperty("--dx", `${dx}px`);
    m.style.setProperty("--dy", `${dy}px`);
    m.style.setProperty("--dur", `${dur}s`);
    m.style.setProperty("--delay", `${delay}s`);
    motes.appendChild(m);
  }
  pane.appendChild(motes);
}

// ---- The stage ---------------------------------------------------------------
// One owner for "which cinematic state are we in". Both tricks here are cheap
// individually and awful together if they disagree — bars sliding out while a
// second set-piece is still running, a push-in released by the wrong window.
// So the state lives in one place and nothing else touches the classes.
//
// Set-pieces nest: a jump scare happens inside a zombie-door sequence, and a
// verdict can land while a fight is still unwinding. Counted rather than
// boolean, so the bars leave when the LAST scene ends rather than the first.
let sceneDepth = 0;

export function enterScene() {
  sceneDepth++;
  document.body.classList.add("staged");
}

export function leaveScene() {
  sceneDepth = Math.max(0, sceneDepth - 1);
  if (sceneDepth === 0) document.body.classList.remove("staged");
}

// Belt and braces for the paths that end a run: whatever was on stage, the
// curtain comes down.
export function clearStage() {
  sceneDepth = 0;
  document.body.classList.remove("staged");
  document.body.classList.remove("pushing");
}

// The board creeps toward you while a decision is open. Slow enough not to
// read as motion, present enough to read as pressure — and released quickly,
// because the relief is the point.
export function pushIn(on) {
  document.body.classList.toggle("pushing", !!on && !reducedMotion());
}

// ---- The unseen --------------------------------------------------------------
// A sound from a direction with nothing behind it, and sometimes something
// crossing a room you are only half looking at.
//
// Deliberately NOT narrated: log() is not called here and the elements are
// aria-hidden. A screen-reader player gets an honest game, because a live
// region that cries wolf is not atmosphere, it is a lie in the only channel
// they have.
export function phantom(dir) {
  if (isCalm()) return; // opted out of being lied to, sound included
  phantomScratch(dir);
  if (reducedMotion()) return;

  // If a neighbour happens to lie that way, something passes through it.
  const half = document.querySelector(`.halfroom--${DIR_CLASS[dir]}`);
  if (!half || half.querySelector(".passing")) return;
  const shade = document.createElement("span");
  shade.className = "passing";
  shade.setAttribute("aria-hidden", "true");
  half.appendChild(shade);
  setTimeout(() => shade.remove(), 2600);
}

// ---- Someone standing --------------------------------------------------------
// The phantom escalated: not a shadow crossing a glimpse but a figure in the
// dark of a door nobody has opened yet. It changes nothing, blocks nothing, and
// is never spoken — a screen reader is told about the room, not about this,
// because a narrated ghost is a fact and this is not one.
//
// It leaves the way it arrived: by the board being rebuilt. No fade. Fades are
// how an interface withdraws something; absence is how a thing that was there
// stops being there, and the difference is the whole effect.

export function standing() {
  if (isCalm()) return false;
  if (reducedMotion()) return false; // it does not move, but the shock does

  // Only the dark. A slot with a half-room in it is a room you can see into and
  // reason about, and putting a figure there would be information; an empty
  // slot is a door with nothing behind it yet.
  const dark = [...document.querySelectorAll(".focus-slot[data-unopened]")].filter(
    (slot) => !slot.querySelector(".standing")
  );
  if (!dark.length) return false;

  // Which one is not a decision — every empty slot is equally nothing — so the
  // first is as good as any, and picking without a die keeps this out of every
  // rng in the file.
  const shape = icon("scene", "standing", "standing");
  if (!shape) return false;
  shape.setAttribute("aria-hidden", "true");
  dark[0].appendChild(shape);

  // A floor under the "next render", because a player who sets the phone down
  // would otherwise leave it standing there until they came back, and a figure
  // you can study is a sprite. Removed outright — no transition on this element
  // for one to run.
  setTimeout(() => shape.remove(), 9000);
  return true;
}

// ---- The candle gutters ------------------------------------------------------
// The light nearly dies. It means nothing, which is exactly why it works: this
// game's cues are honest, so the one that carries no information is the one
// that makes the room untrustworthy rather than the game unfair.
//
// Driven entirely through the light model — one multiplier, three dials — so
// the vignette, the glow and the peeked half-rooms sag together. That is what
// separates "the candle is failing" from "an element is animating".

const GUTTER_MS = 1100;
const GUTTER_MS_CALM_MOTION = 1800; // the reduced-motion shape is slower
let guttering = false;

// A gutter is 800ms during which room names are below the contrast floor. That
// is affordable while the player is reading, and not affordable while they are
// choosing: if a decision is on screen, the light stays up.
function decisionPending() {
  // All of them, not the first: querySelector would answer for whichever pop
  // happens to come first in the document and miss a second one standing open.
  for (const pop of document.querySelectorAll(".actions-pop")) {
    if (!pop.hidden) return true;
  }
  const focused = document.activeElement;
  // Note what this does NOT gate on: doorways merely being present. They are
  // present for most of every turn, and gating on that would mean the candle
  // never gutters at all. A doorway with focus on it is someone mid-choice; a
  // doorway on screen is just the room.
  return !!(focused && focused.closest && focused.closest(".doorway, .actions-pop"));
}

export function candleGutter() {
  if (isCalm()) return; // the opt-out covers the light as well as the noise
  // The sound goes either way. It is not motion, it costs no readability, and
  // a player who cannot see the flame fail should still hear it.
  wickHiss();
  if (guttering || decisionPending()) return;

  const body = document.body;
  if (!body) return;
  guttering = true;
  body.classList.add("guttering");
  // Timer-backed rather than animationend: a hidden tab does not advance
  // animations, and a class that only comes off when the animation finishes
  // would leave the room dark for as long as the player is away.
  setTimeout(() => {
    body.classList.remove("guttering");
    guttering = false;
  }, (reducedMotion() ? GUTTER_MS_CALM_MOTION : GUTTER_MS) + 60);
}

// ---- The wall failing, in stages -----------------------------------------------
// A wall in a film does not become a hole. It takes a knock, then a harder one,
// then it cracks, then something comes through it, and only then does it fall.
// The game already had those moments — a telegraph knock, a scare, a fight, a
// 460ms burst — but nothing joined them up, so it read as three unrelated
// effects and an instant hole.
//
// This is the sequence owner, the same shape the burial has: one module that
// knows every stage, so the stages can share state (which wall, how far gone)
// and so tearing the whole thing down is one call rather than five.
//
// The wall it stages on is a PREDICTION. pickZombieDoorWall is a pure read and
// can be asked early, but fleeing moves the answer — so nothing here punches
// state, and stage five re-anchors the whole sequence onto whatever wall the
// board actually chose. Never punch state early; stage on the guess.

const breakIn = {
  dir: null,
  el: null, // the falling-debris strip, only during the collapse
  // Which wall art is standing in for the wall right now. No board state says
  // "cracked" — the board only knows walls and holes — so this is the sequence
  // remembering what it put there, and renderBoard puts it back after a
  // re-render rather than losing it mid-fight.
  wall: null, // "wall-cracked" | "wall-breached" | null
  grasping: false, // whether the arms should still be reaching after a render
};

// The stage names are the phases of the turn, not the frames of an animation:
// telegraph runs while the card resolves, cracks as the sting lands, pressure
// for as long as the choice is open, collapse on resolution.
// The wall art, standing where an edge mark would. Built and placed exactly
// like every other one — same class, same rotation — so a cracked north wall
// and a cracked east wall need no separate geometry.
function mountBreachWall(dir, symbol) {
  const box = document.querySelector(".focus-centre .tilebox");
  if (!box) return null;
  const old = box.querySelector(".edgemark--breach");
  if (old) old.remove();
  const wrap = document.createElement("span");
  wrap.className = `edgemark ${DIR_CLASS[dir] || "n"} edgemark--breach`;
  wrap.setAttribute("aria-hidden", "true"); // describeRoom says it in words
  const art = icon("edge", symbol, "edgeart");
  if (!art) return null;
  wrap.appendChild(art);
  box.appendChild(wrap);
  return wrap;
}

// Called at the end of every board render: the fight is still on, so whatever
// the wall was doing it should still be doing.
function restoreBreachWall() {
  if (!breakIn.dir || !breakIn.wall) return;
  const wrap = mountBreachWall(breakIn.dir, breakIn.wall);
  // And still reaching. Without this the arms come back frozen after any
  // mid-fight render — a cower, a heal, anything that refreshes the board —
  // which is a wall that stopped being attacked while the fight is still on.
  if (wrap && breakIn.grasping && !reducedMotion()) wrap.classList.add("edgemark--grasping");
}

// The debris strip. Only the falling pieces live here now — the cracks are the
// wall art above, which is a sprite on the edge grid rather than four rotated
// divs pretending to be one.
function breachEl(dir) {
  const box = document.querySelector(".focus-centre .tilebox");
  if (!box) return null;
  const el = document.createElement("span");
  el.className = `breach breach--${DIR_CLASS[dir] || "n"}`;
  el.setAttribute("aria-hidden", "true");
  box.appendChild(el);
  return el;
}

// Stage 1 — while the card resolves. Two knocks, the second harder and late
// enough to be a second knock rather than an echo.
export function breakInTelegraph(dir) {
  breakIn.dir = dir;
  telegraphWall(dir);
  // The pause is the point. One knock is a noise; a knock, a gap, and a harder
  // knock is something working at it.
  setTimeout(() => telegraphWall(dir, 1.35), 620);
}

// Stage 2 — the sting lands and the wall is visibly losing. In calm mode this
// does nothing at all: the stages collapse back to the single burst at the end,
// which is what calm mode promised.
export function breakInCracks(dir) {
  if (isCalm()) {
    // Calm mode gets the cracked wall and nothing that comes through it: the
    // information that a wall is failing, without being reached for.
    breakIn.dir = dir || breakIn.dir;
    breakIn.wall = "wall-cracked";
    mountBreachWall(breakIn.dir, breakIn.wall);
    return;
  }
  breakIn.dir = dir || breakIn.dir;
  breakIn.wall = "wall-cracked";
  // The sound of it cracking, panned to the wall. Plays under calm mode too —
  // the branch above returns before this, so calm gets the cracked picture and
  // the cracks are all it gets; the splintering belongs to the full sequence.
  splintering(breakIn.dir, 3);
  const wrap = mountBreachWall(breakIn.dir, breakIn.wall);
  if (wrap && !reducedMotion()) wrap.classList.add("edgemark--cracking");
}

// Stage 3 — the window is open and you are choosing a weapon. The wall stays
// cracked and pounds faintly. Pressure, not an event: nothing here resolves,
// interrupts, or asks for a frame of the player's time.
// Stage three — the hands. Between the cracks and the collapse, arms come
// through and stay there for the length of the fight, which is the single most
// iconic image this game did not have. Pressure, not an event: nothing here
// resolves, interrupts, or asks for a frame of the player's time.
//
// Calm mode keeps the cracked wall and nothing else. Reduced motion gets the
// arms but not the grasping — they are through the wall either way, and that is
// the fact; the reaching is the decoration.
export function breakInPressure() {
  if (isCalm() || !breakIn.dir) return;
  breakIn.wall = "wall-breached";
  breakIn.grasping = true;
  // Coming through costs the wall more of itself, and then it is worked on for
  // as long as the choice is open. The pounding is held — every exit from the
  // fight stops it, and muting frees it — because a wall still being hit after
  // the fight is over is the failure mode a held cue always has.
  splintering(breakIn.dir, 5);
  startPounding(breakIn.dir);
  const wrap = mountBreachWall(breakIn.dir, breakIn.wall);
  if (wrap && !reducedMotion()) wrap.classList.add("edgemark--grasping");
}

// Stage 5 — they followed you. The prediction was wrong, so the whole sequence
// moves: a fast knock and a crack in the room you actually reached, and then
// the collapse happens there.
export function breakInReanchor(dir) {
  breakIn.dir = dir;
  if (isCalm() || reducedMotion()) return Promise.resolve();
  breakInCracks(dir);
  telegraphWall(dir, 1.2);
  // Short — this is a catch-up, not a second telegraph. The player has already
  // had the slow version once this turn.
  return new Promise((resolve) => setTimeout(resolve, 340));
}

// Stage 4 — the collapse. The old animateBreakIn was one 460ms burst on the
// hole art; this widens the cracks first, drops the section in two pieces, and
// only then lets the hole settle in behind it.
export function breakInCollapse(dir) {
  freshHole = dir;
  stopPounding();
  breakThrough();
  // They are not behind anything now. The murmur opens up and steps to the
  // loudest it is ever allowed to be — the one moment the mix reserves that
  // headroom for.
  floodMurmur();
  if (reducedMotion() || isCalm()) {
    breakIn.dir = dir;
    breakInClear();
    return animateBreakIn(dir, { quiet: true }); // the single burst, as before
  }

  // The overlay from stage two is usually gone by now: opening the hole
  // re-renders the board, and renderBoard rebuilds .focus from nothing. So the
  // one that is still standing is only reusable if it survived the render AND
  // is on the wall that actually gave — a prediction that turned out wrong has
  // to be dropped, not collapsed.
  if (!(breakIn.el && breakIn.el.isConnected && breakIn.dir === dir)) {
    if (breakIn.el) breakIn.el.remove();
    breakIn.el = breachEl(dir);
  }
  breakIn.dir = dir;
  breakIn.wall = null; // the wall is going; nothing to restore after this
  breakIn.grasping = false;

  // They pull it down: the arms withdraw an instant before the section goes,
  // which is the difference between the wall failing and the wall being pulled.
  const arms = document.querySelector(".edgemark--breach");
  if (arms) {
    arms.classList.remove("edgemark--grasping", "edgemark--cracking");
    arms.classList.add("edgemark--pulling");
  }

  const el = breakIn.el;
  if (el) {
    el.classList.add("breach--failing");
    // Two chunks, falling inward at different rates — one piece reads as a
    // panel sliding, two read as masonry.
    for (const lead of [0, 1]) {
      const chunk = document.createElement("b");
      chunk.style.setProperty("--lead", String(lead));
      el.appendChild(chunk);
    }
    setTimeout(() => breakInClear(), 620);
  }
  // The burst underneath it, after the pieces have started to go: the hole is
  // what is left when the wall has finished failing, not what replaces it.
  setTimeout(() => animateBreakIn(dir, { quiet: true }), el ? 300 : 0);
  return Promise.resolve();
}

// Always safe to call, and called on every exit from the fight — a flee, a
// verdict, a new game. A wall left pounding forever is the failure mode a held
// effect always has.
export function breakInClear() {
  stopPounding();
  if (breakIn.el) breakIn.el.remove();
  breakIn.el = null;
  breakIn.wall = null;
  breakIn.dir = null;
  breakIn.grasping = false;
  for (const n of document.querySelectorAll(".edgemark--breach")) n.remove();
}

// ---- Telegraphing the zombie door ------------------------------------------
// The wall they are about to come through knocks once, while the card is still
// being read. It is the difference between a stat event and a horror beat: you
// hear where it will happen one beat before it does.
//
// The direction is knowable in advance because isDeadEnd and pickZombieDoorWall
// are pure reads — no state moves here, this only says out loud what the board
// already decided.
export function telegraphWall(dir, force = 1) {
  wallThump(dir, force);
  if (reducedMotion()) return; // the knock stays; the dust is the motion part

  const box = document.querySelector(".focus-centre .tilebox");
  if (!box || typeof box.animate !== "function") return;

  const dust = document.createElement("span");
  dust.className = `wallshake wallshake--${DIR_CLASS[dir] || "n"}`;
  dust.setAttribute("aria-hidden", "true");
  // Fixed offsets rather than random ones: the same warning should look the
  // same twice, the house rule everywhere else here follows.
  for (const [along, delay] of [[22, 0], [40, 90], [58, 40], [76, 140], [88, 200]]) {
    const mote = document.createElement("i");
    mote.style.setProperty("--along", `${along}%`);
    mote.style.animationDelay = `${delay}ms`;
    dust.appendChild(mote);
  }
  box.appendChild(dust);
  setTimeout(() => dust.remove(), 1400);

  // And the wall itself takes the knock, once.
  const edge = box.querySelector(`.edgemark.${DIR_CLASS[dir]}`) || box;
  const [ax, ay] = (dir === "N" || dir === "S" ? [0, dir === "N" ? 2 : -2] : [dir === "W" ? 2 : -2, 0])
    .map((v) => v * force);
  edge.animate(
    [
      { transform: "translate(0, 0)" },
      { transform: `translate(${ax}px, ${ay}px)` },
      { transform: `translate(${-ax * 0.5}px, ${-ay * 0.5}px)` },
      { transform: "translate(0, 0)" },
    ],
    { duration: 260, easing: "ease-out" }
  );
}

// ---- The door onto darkness --------------------------------------------------
// Opening a door on a room nobody has seen is the scare surface of the whole
// game, and it used to cost nothing: click, tile, slide. One beat goes in
// between. The door swings onto black, the hinge sounds, nothing happens for a
// moment, and only then does the light reach in and the room resolve.
//
// Only for the unknown. Walking back into a room you have already stood in
// stays instant — dread is for what you have not seen.
const DARK_HOLD_MS = 600;

export function darkDoorBeat(dir, fear = 0) {
  return new Promise((resolve) => {
    const pane = document.querySelector(".board-pane");
    // The hinge is a cue, not a picture: it plays even when the beat does not.
    // Placed on the wall being opened — this is the door in front of you, not
    // the one you came through.
    doorCreak(dir);
    if (!pane || reducedMotion() || typeof pane.animate !== "function") return resolve();

    const stale = pane.querySelector(".darkdoor");
    if (stale) stale.remove();

    const dark = document.createElement("div");
    dark.className = `darkdoor darkdoor--${DIR_CLASS[dir] || "n"}`;
    dark.setAttribute("aria-hidden", "true");
    pane.appendChild(dark);

    // A frightened door holds longer. Not enough to notice as a delay, enough
    // that a 9 PM door and an 11:40 door are not the same door.
    const hold = Math.round(DARK_HOLD_MS * (1 + fear * 0.55));

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      dark.remove();
      resolve();
    };
    // Timer-backed for the same reason every awaited beat here is: animations
    // do not advance in a hidden tab, and a turn must never hang on one.
    setTimeout(done, hold);
  });
}

// The wall going in. Staged so the damage reads: the ragged edges snap in
// oversized, settle back, and the room takes the knock. The static art is
// already in place underneath, so under reduced motion the hole is simply
// there — nothing is lost by skipping this.
export function animateBreakIn(dir, opts = {}) {
  // Sound first and unconditionally, the same rule the door follows: the cue is
  // the wall coming in, and that happened whether or not the picture plays.
  // `quiet` is for the staged version, which has already played the crash at
  // the top of the collapse — the burst here is the tail of that, not a second
  // wall giving way.
  if (!opts.quiet) breakThrough();
  if (reducedMotion()) return;
  enterScene();
  setTimeout(leaveScene, 1200);
  requestAnimationFrame(() => {
    const art = document.querySelector(`.focus-centre .tilebox .edgemark.${DIR_CLASS[dir]} .edgeart`);
    if (art && typeof art.animate === "function") {
      art.animate(
        [
          { opacity: 0, transform: "scale(.35)" },
          { opacity: 1, transform: "scale(1.3)", offset: 0.32 },
          { opacity: 1, transform: "scale(.96)", offset: 0.62 },
          { opacity: 1, transform: "scale(1)" },
        ],
        { duration: 460, easing: "cubic-bezier(.2,.9,.3,1)" }
      );
    }
    const box = document.querySelector(".focus-centre .tilebox");
    if (box && typeof box.animate === "function") {
      const [dx, dy] = DELTA[dir] || [0, 0];
      // knocked away from the wall that just gave
      box.animate(
        [
          { transform: "translate(0,0)" },
          { transform: `translate(${-dx * 6}px, ${-dy * 6}px)` },
          { transform: `translate(${dx * 3}px, ${dy * 3}px)` },
          { transform: "translate(0,0)" },
        ],
        { duration: 300, easing: "ease-out" }
      );
    }
  });
}

// ---- Taking a hit ----------------------------------------------------------
// A red wash over the board and a short shake. Sits below the jump scare so the
// two do not fight when a fight is what dealt the damage.
// Where the damage came from, when anything knows. Set by the fight or the
// flight just before the health changes, read once, and cleared — a direction
// left lying around would bias the next unrelated hit.
let hurtFrom = null;
export function damageCameFrom(dir) {
  hurtFrom = dir || null;
}

function damageFeedback() {
  // Not sound, so mute does not govern it, and not motion either — a short
  // knock is the one cue a player can feel with the screen away from them.
  buzz(30);
  if (reducedMotion()) return;

  const pane = document.querySelector(".board-pane");
  if (pane && typeof pane.animate === "function") {
    pane.animate(
      [
        { transform: "translate(0, 0)" },
        { transform: "translate(-5px, 2px)" },
        { transform: "translate(4px, -2px)" },
        { transform: "translate(-2px, 1px)" },
        { transform: "translate(0, 0)" },
      ],
      { duration: 160, easing: "ease-out" }
    );
  }

  const existing = document.querySelector(".hitflash");
  if (existing) existing.remove();
  const flash = document.createElement("div");
  // Weighted toward the threat when the threat has a direction — the wall the
  // pack came through, or the door you fled by. Uniform when it does not, which
  // is honest: a card that hurts you came from nowhere in particular.
  flash.className = `hitflash${hurtFrom ? " hitflash--" + DIR_CLASS[hurtFrom] : ""}`;
  flash.setAttribute("aria-hidden", "true");
  document.body.appendChild(flash);
  if (typeof flash.animate !== "function") {
    flash.remove();
    return;
  }
  hurtFrom = null; // one hit, one direction
  const anim = flash.animate(
    [{ opacity: 0 }, { opacity: 0.5, offset: 0.18 }, { opacity: 0 }],
    { duration: 380, easing: "ease-out" }
  );
  let gone = false;
  const clear = () => {
    if (gone) return;
    gone = true;
    flash.remove();
  };
  anim.finished.then(clear).catch(clear);
  // Animations stall while the tab is hidden; never leave a red sheet behind.
  setTimeout(clear, 700);
}

// ---- Moving between rooms --------------------------------------------------
// Three layers, played together after the new room is rendered: the door you
// came through swings open, footprints track from that doorway to where you're
// standing, and the whole view slides one room in the direction travelled.
//
// Purely decorative — state has already changed and nothing waits on these, so
// clicking straight through a move can never desync the board.
const SLIDE_MS = 700;
const DOOR_MS = 300;
const FOOT_MS = 360;
const FOOT_STAGGER = 78;
const OPPOSITE = { N: "S", E: "W", S: "N", W: "E" };

// The one predicate every intense effect asks. Two independent gates: reduced
// motion is the OS saying "do not move things at me", calm is the player saying
// "do not frighten me". Either is enough to hold an effect back, and neither
// implies the other.
function intense() {
  return !reducedMotion() && !isCalm();
}

function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

// Deferred to the next frame on purpose: resolving the room's card refreshes the
// board again, and renderBoard rebuilds .focus from scratch, so animating the
// element that exists right now would animate a node about to be thrown away.
export function animateEntry(dir) {
  const [dx, dy] = DELTA[dir] || [0, 0];
  if (!dx && !dy) return;

  // Sound is not motion, so the hinge is heard even with animation turned off.
  // Only for a real door — a smashed wall has nothing to swing.
  const back = OPPOSITE[dir];
  const backEdge = document.querySelector(`.focus-centre .tilebox .edgemark.${DIR_CLASS[back]}`);
  // The door is behind you now — you came through it — so both the hinge and
  // the steps are placed on the wall you actually used.
  if (backEdge && !backEdge.classList.contains("edgemark--broken")) doorCreak(back);
  // And the walk in, on whatever the floor is here — boards or grass.
  footsteps(
    document.getElementById("board")?.classList.contains("board--outdoor") ? "outdoor" : "indoor",
    back
  );

  if (reducedMotion()) return;

  requestAnimationFrame(() => {
    const view = document.querySelector(".focus");
    if (!view || typeof view.animate !== "function") return;

    slideView(view, dx, dy);

    const box = view.querySelector(".focus-centre .tilebox");
    if (!box) return;
    const back = OPPOSITE[dir]; // the wall you came through, in the new room
    swingDoor(box, back);
    trackFootprints(box, back);
  });
}

function slideView(view, dx, dy) {
  const tile = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tile")) || 170;
  const gap = parseFloat(getComputedStyle(view).rowGap) || 0;
  const step = tile + gap;
  view.animate(
    [
      { transform: `translate(${dx * step}px, ${dy * step}px)` },
      { transform: "translate(0, 0)" },
    ],
    { duration: SLIDE_MS, easing: "cubic-bezier(.22,.61,.36,1)" }
  );
}

// A leaf hinged in the doorway, swinging inward. Skipped for a broken wall —
// there is no door there to open.
function swingDoor(box, back) {
  const edge = box.querySelector(`.edgemark.${DIR_CLASS[back]}`);
  if (!edge || edge.classList.contains("edgemark--broken")) return;

  const swing = document.createElement("span");
  swing.className = `doorswing ${DIR_CLASS[back]}`;
  swing.setAttribute("aria-hidden", "true");
  const leaf = document.createElement("span");
  leaf.className = "leaf";
  swing.appendChild(leaf);
  box.appendChild(swing);

  const anim = leaf.animate(
    [
      { transform: "rotate(0deg)", opacity: 1 },
      { transform: "rotate(74deg)", opacity: 1, offset: 0.75 },
      { transform: "rotate(74deg)", opacity: 0 },
    ],
    { duration: DOOR_MS, easing: "cubic-bezier(.3,.7,.4,1)" }
  );
  anim.finished.then(() => swing.remove()).catch(() => swing.remove());
}

// Footprints from the doorway to the middle of the room, alternating left and
// right of the line of travel, fading in one after another.
function trackFootprints(box, back) {
  const track = document.createElement("span");
  track.className = "steps";
  track.setAttribute("aria-hidden", "true");

  const along = [88, 76, 64, 52]; // percent from the wall, inward
  const count = along.length;
  for (let i = 0; i < count; i++) {
    const foot = document.createElement("span");
    foot.className = "step";
    const side = i % 2 ? 57 : 43; // left/right of the walking line
    const near = along[i];
    if (back === "S") { foot.style.top = `${near}%`; foot.style.left = `${side}%`; }
    else if (back === "N") { foot.style.top = `${100 - near}%`; foot.style.left = `${side}%`; }
    else if (back === "E") { foot.style.left = `${near}%`; foot.style.top = `${side}%`; }
    else { foot.style.left = `${100 - near}%`; foot.style.top = `${side}%`; }
    foot.style.transform = `translate(-50%, -50%) rotate(${back === "N" || back === "S" ? 0 : 90}deg)`;
    track.appendChild(foot);

    foot.animate(
      [{ opacity: 0 }, { opacity: 0.9, offset: 0.35 }, { opacity: 0 }],
      { duration: FOOT_MS, delay: DOOR_MS * 0.5 + i * FOOT_STAGGER, easing: "ease-out" }
    );
  }
  box.appendChild(track);
  setTimeout(() => track.remove(), DOOR_MS * 0.5 + count * FOOT_STAGGER + FOOT_MS + 60);
}

function centreRoom(game, tile, edges) {
  const box = document.createElement("div");
  box.className = `tilebox tilebox--here world--${tile.world}`;
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", describeRoom(game, tile, edges));

  // The aftermath, before the edge marks so it sits under them: a hole is a
  // permanent, two-sided piece of board state, so this draws itself in both
  // rooms and on every visit for the rest of the run. That permanence is the
  // point — the map remembers where a wall came in.
  for (const dir of tile.holes || []) aftermath(box, dir);

  for (const dir of DIRS) {
    const mark = edgeMark(dir, edges[dir]);
    if (mark) box.appendChild(mark);
  }

  const sceneId = SCENE_ALIAS[tile.id] || tile.id;
  const scene = icon("scene", sceneId, `roomscene${SCENE_RICH.has(sceneId) ? " roomscene--rich" : ""}`);
  if (scene) box.appendChild(scene);

  const name = document.createElement("span");
  name.className = "tilename";
  name.textContent = tileName(game, tile.id);
  name.setAttribute("aria-hidden", "true");
  box.appendChild(name);

  const badges = badgeRow(tileBadges(game, tile));
  if (badges) box.appendChild(badges);
  return box;
}

// ---- The wound in the house ----------------------------------------------------
// What is left after a wall comes in. Three things, and only the first of them
// survives calm mode, because only the first is information: gouges are a map
// telling you a hole is here and can be used, and the other two are dread.
//
// Nothing here plays a sound or takes a frame of the player's time. Aftermath
// is texture, not a beat.

// Which hole the dust is still settling in, if any. Cleared at the start of the
// next turn — dust that hangs forever is not dust, it is a decal.
let freshHole = null;

function aftermath(box, dir) {
  const d = DIR_CLASS[dir] || "n";

  // Claw marks, dragged from the opening toward the middle of the room. Fixed
  // positions like everything else here: the same hole should look the same
  // twice, in this run and in a shared one.
  const gouges = document.createElement("span");
  gouges.className = `gouges gouges--${d}`;
  gouges.setAttribute("aria-hidden", "true");
  for (const [along, reach, tilt] of [[38, 54, -9], [50, 68, 3], [62, 46, 11]]) {
    const line = document.createElement("i");
    line.style.setProperty("--along", `${along}%`);
    line.style.setProperty("--reach", `${reach}%`);
    line.style.setProperty("--tilt", `${tilt}deg`);
    gouges.appendChild(line);
  }
  box.appendChild(gouges);

  if (isCalm() || reducedMotion()) return;

  // The dark beyond it. A hole is not a door: nothing was ever going to close
  // it, and the outside is on the other side of it for the rest of the night.
  // Depth follows the dread dial, so the same opening is a shadow at nine
  // o'clock and a throat at midnight.
  const dark = document.createElement("span");
  dark.className = `holedark holedark--${d}`;
  dark.setAttribute("aria-hidden", "true");
  box.appendChild(dark);

  // And for the turn it was made in, the dust has not settled.
  if (freshHole === dir) {
    const dust = document.createElement("span");
    dust.className = `holedust holedust--${d}`;
    dust.setAttribute("aria-hidden", "true");
    for (const [along, delay, dur] of [[34, 0, 5.5], [46, 900, 7], [55, 400, 6.2], [66, 1500, 5]]) {
      const mote = document.createElement("i");
      mote.style.setProperty("--along", `${along}%`);
      mote.style.animationDelay = `${delay}ms`;
      mote.style.animationDuration = `${dur}s`;
      dust.appendChild(mote);
    }
    box.appendChild(dust);
  }
}

// The turn moves on and the air clears. Called from the start of the next turn
// rather than on a timer: "the rest of this turn" is a game-length, and a
// wall-clock version of it would be wrong at both ends.
export function settleDust() {
  freshHole = null;
}

// What a room does, said on the room. Read off the tile's own definition
// rather than a list of room ids, so a data change carries the badge with it —
// move HEAL_1 to another room and the heart follows.
//
// The two goal badges are stateful, and that is most of their value: the relic
// marker is on the Reliquary only while the relic is still in it, and moves to
// the Family Plot the moment you are carrying it. The board answers "where am
// I going" without being asked.
function tileBadges(game, tile) {
  const def = (tile && tile.def) || {};
  const held = game.state.totem;
  const out = [];
  if (def.onResolve === "SECOND_CARD_THEN_GAIN_TOTEM" && !held) {
    out.push({ kind: "relic", kindName: "ui", id: "relic", say: "The relic rests here." });
  }
  if (def.onResolve === "SECOND_CARD_THEN_BURY_TOTEM" && held) {
    out.push({ kind: "relic", kindName: "ui", id: "relic", say: "Bury the relic here." });
  }
  if (def.onTurnEnd === "HEAL_1") {
    out.push({ kind: "hearth", kindName: "stat", id: "heart", say: "Resting here heals you." });
  }
  return out;
}

// Corners only. The centre of a tile belongs to the footprints and the
// hotspots, and the bottom-left is the name's.
function badgeRow(badges) {
  if (!badges.length) return null;
  const row = document.createElement("span");
  row.className = "tilebadges";
  row.setAttribute("aria-hidden", "true"); // describeRoom says it in words
  for (const b of badges) {
    const chip = document.createElement("span");
    chip.className = `tilebadge tilebadge--${b.kind}`;
    const art = icon(b.kindName, b.id, "tilebadge-art");
    if (art) chip.appendChild(art);
    if (b.kind === "hearth") {
      const plus = document.createElement("span");
      plus.className = "tilebadge-num";
      plus.textContent = "+1";
      chip.appendChild(plus);
    }
    row.appendChild(chip);
  }
  return row;
}

// The far half of a neighbour is masked away, so it reads as a room you can see
// into rather than a room you are in.
function halfRoom(game, edge, dir) {
  const half = document.createElement("div");
  half.className = `halfroom halfroom--${DIR_CLASS[dir]} world--${edge.neighbour.world}`;
  if (edge.crossesWorld) half.classList.add("halfroom--across");
  half.setAttribute("aria-hidden", "true"); // already in the centre room's label

  const glimpseId = SCENE_ALIAS[edge.neighbour.id] || edge.neighbour.id;
  const scene = icon("scene", glimpseId, `roomscene${SCENE_RICH.has(glimpseId) ? " roomscene--rich" : ""}`);
  if (scene) half.appendChild(scene);

  const name = document.createElement("span");
  name.className = "tilename";
  name.textContent = tileName(game, edge.neighbour.id);
  half.appendChild(name);

  // Worth more here than on the room you are standing in: this is the board
  // telling you the relic is through that door before you commit the turn.
  // Pinned to the strip rather than to the scene, so the crop cannot eat it.
  const badges = badgeRow(tileBadges(game, edge.neighbour));
  if (badges) half.appendChild(badges);
  return half;
}

function edgeMark(dir, edge) {
  if (edge.kind === "wall") return null;

  let symbol;
  let tone;
  if (edge.kind === "broken") {
    symbol = "wall-broken";
    tone = "broken";
  } else if (edge.arrow && (edge.state === "outside" || edge.crossesWorld)) {
    symbol = "door-exterior";
    tone = "exterior";
  } else if (edge.state === "open") {
    symbol = "door-open";
    tone = "open";
  } else if (edge.state === "blocked") {
    symbol = "door-blocked";
    tone = "blocked";
  } else {
    symbol = "door-closed";
    tone = "shut";
  }

  const wrap = document.createElement("span");
  wrap.className = `edgemark ${DIR_CLASS[dir]} edgemark--${tone}`;
  wrap.setAttribute("aria-hidden", "true");
  const art = icon("edge", symbol, "edgeart");
  if (art) wrap.appendChild(art);
  return wrap;
}

// One sentence covering the room and all four walls, so the board is playable
// without seeing it.
function describeRoom(game, tile, edges) {
  const parts = [`${tileName(game, tile.id)}, you are here.`];
  // The badges are aria-hidden pictures; this is where they are actually said.
  for (const b of tileBadges(game, tile)) parts.push(b.say);
  for (const dir of DIRS) {
    const e = edges[dir];
    const where = DIR_WORD[dir];
    if (e.state === "wall") {
      // The one transient thing this sentence reports. A wall being broken
      // through is a fact about the room and it decides what the player does
      // next, so it is said — unlike the phantoms, which are not facts.
      parts.push(
        breakIn.dir === dir && breakIn.wall
          ? `To the ${where}, a wall giving way — they are coming through it.`
          : `To the ${where}, a wall.`
      );
    } else if (e.state === "outside") {
      parts.push(`To the ${where}, the arrow door leading outside.`);
    } else if (e.state === "open") {
      const thing = e.kind === "broken" ? "a broken wall" : e.arrow ? "the arrow door" : "an open door";
      const room = e.neighbour ? tileName(game, e.neighbour.id) : "somewhere explored";
      parts.push(`To the ${where}, ${thing} into the ${room}${e.crossesWorld ? ", across the threshold" : ""}.`);
    } else if (e.state === "blocked") {
      const thing = e.kind === "broken" ? "a broken wall" : "a door";
      parts.push(`To the ${where}, ${thing} that leads nowhere.`);
    } else {
      const thing = e.kind === "broken" ? "a broken wall" : "a shut door";
      parts.push(`To the ${where}, ${thing}, unexplored beyond.`);
    }
  }
  return parts.join(" ");
}

export function log(msg, cls = "") {
  const el = document.getElementById("log");
  if (!el) return;
  const p = document.createElement("p");
  if (cls) p.className = cls;
  p.textContent = msg;
  el.prepend(p);
}

export function clearLog() {
  const el = document.getElementById("log");
  if (el) el.innerHTML = "";
}

// A line over the board that fades. Most of what the log used to say is now
// shown rather than told — damage flashes, hearts price the choices, the pack
// falls over, the clock moves. What is left are the moments with no other
// picture: the writing on a card, and the hour striking.
//
// aria-hidden, because log() has already announced it to the live region and
// saying it twice is worse than not seeing it once.
let captionTimer = null;
export function caption(msg, tone = "") {
  const pane = document.querySelector(".board-pane");
  if (!pane || !msg) return;
  const old = pane.querySelector(".caption");
  if (old) old.remove();
  clearTimeout(captionTimer);

  const el = document.createElement("p");
  el.className = `caption${tone ? " caption--" + tone : ""}`;
  el.setAttribute("aria-hidden", "true");
  el.textContent = msg;
  pane.appendChild(el);

  // Timer rather than animationend: animations do not advance in a hidden tab,
  // and a caption that never left would sit over the board forever.
  const life = tone === "toll" ? 5200 : 4200;
  captionTimer = setTimeout(() => el.remove(), life);
}

// Hearts, using the same symbol the status panel does. Zero reads as safe
// rather than as a cost — out-levelling a pack is this ruleset's reward and
// should look like one.
function costRow(hp) {
  const row = document.createElement("span");
  const kind = hp > 0 ? "gain" : hp < 0 ? "cost" : "safe";
  row.className = `action-cost action-cost--${kind}`;
  row.setAttribute("aria-hidden", "true");

  if (hp === 0) {
    row.textContent = "unharmed";
    return row;
  }
  const n = document.createElement("span");
  n.className = "action-cost-num";
  n.textContent = `${hp > 0 ? "+" : "−"}${Math.abs(hp)}`;
  row.appendChild(n);
  for (let i = 0; i < Math.min(Math.abs(hp), 4); i++) {
    const h = icon("stat", "heart", `costheart costheart--${kind}`);
    if (h) row.appendChild(h);
  }
  return row;
}

// A count of hearts you do not have is not information. Past the point where
// the arithmetic stops mattering, say the only thing that does.
function lethalRow() {
  const row = document.createElement("span");
  row.className = "action-cost action-cost--lethal";
  row.setAttribute("aria-hidden", "true");
  const sk = icon("ui", "skull", "action-skull");
  if (sk) row.appendChild(sk);
  row.appendChild(document.createTextNode("this kills you"));
  return row;
}

function costSentence(hp) {
  if (hp === 0) return "you take no damage";
  if (hp > 0) return `you gain ${hp} health`;
  return `you will take ${Math.abs(hp)} damage`;
}

// The window's fixed header. Created once and emptied per render, so the pack
// and prompt can sit outside the scrolling card list.
function windowHead(pop, actionsEl) {
  if (!pop) return null;
  let head = pop.querySelector(".window-head");
  if (!head) {
    head = document.createElement("div");
    head.className = "window-head";
    pop.insertBefore(head, actionsEl);
  }
  head.textContent = "";
  return head;
}

// The pack, present for the whole fight rather than a flash and a digit. The
// scare deposited them; this is what it left behind.
function packRow(count) {
  const row = document.createElement("div");
  row.className = "packrow";
  row.setAttribute("aria-hidden", "true"); // the prompt already says how many
  for (let i = 0; i < count; i++) {
    const fig = icon("scare", "zombie", "packfig");
    if (!fig) break;
    row.appendChild(fig);
  }
  return row;
}

// The first nine actions get a number-key shortcut. One delegated listener,
// installed on the first render, reads the live button list each keypress.
let keysBound = false;
function bindActionKeys() {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > 9) return;
    const b = currentChoices()[n - 1];
    if (b && !b.disabled) {
      e.preventDefault();
      b.click();
    }
  });

  // Arrows drive the doorways, and flee cards by the same dir metadata. Only
  // swallowed when something actually matches, so the page still scrolls
  // otherwise.
  document.addEventListener("keydown", (e) => {
    const dir = ARROW_KEY[e.key];
    if (!dir || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const target = currentChoices().find((b) => b.dataset.dir === dir && !b.disabled);
    if (!target) return;
    e.preventDefault();
    target.click();
  });
}

// Render a set of action buttons. `actions` = [{label, onClick, primary?}].
//
// These live in a pop-out over the board rather than a fixed sidebar panel, so
// the choice sits next to what the player is looking at and takes no room when
// there is nothing to decide.
//
// There is deliberately no way to dismiss it. Every state that renders actions
// requires one of them to be chosen — moving is mandatory, a fight must be
// resolved, a zombie door must be given a wall — so a close button or an
// Escape binding would only ever strand the player with no way to act. It
// hides when the list is empty, which is the one moment nothing is being asked.
//
// It is also deliberately not a modal and traps no focus: with no dismiss, a
// focus trap would lock a keyboard player away from New game for the rest of
// the run. Tab reaches the sidebar as normal; the number keys stay bound
// globally.
export function renderActions(actions, prompt = "", opts = {}) {
  const el = document.getElementById("actions");
  const pop = document.getElementById("actions-pop");
  // Keep the keyboard on the turn loop, but don't yank focus out of the
  // sidebar controls if that's where the player put it. Focus may be on a
  // doorway from the previous render, which counts as being in the turn loop.
  const hadFocus =
    el.contains(document.activeElement) ||
    (document.activeElement && document.activeElement.classList.contains("doorway"));
  el.innerHTML = "";
  clearDoorways();
  pendingMoves = [];
  movePrompt = "";

  if (!actions.length) {
    if (pop) pop.hidden = true;
    pushIn(false);
    return;
  }

  // A decision is open: the board starts closing in. Moves are not a decision
  // in this sense — walking is what you do between them, and a push-in that
  // never released would just be a zoom.
  pushIn(!actions.every((a) => a.kind === "move" && a.dir));

  // Moving is the one thing the board can say better than a list. When every
  // choice is a move, the doorways become the buttons and the panel stays shut.
  if (actions.every((a) => a.kind === "move" && a.dir)) {
    pendingMoves = actions;
    movePrompt = prompt;
    if (pop) pop.hidden = true;
    const board = document.getElementById("board");
    if (board) mountDoorways(board);
    bindActionKeys();
    if (hadFocus || document.activeElement === document.body) {
      const first =
        document.querySelector(".doorway--explore:not(:disabled)") ||
        document.querySelector(".doorway:not(:disabled)");
      if (first) first.focus();
    }
    // The prompt lived in the panel; with no panel it has to be said somewhere.
    if (prompt) log(prompt);
    return;
  }

  if (pop) pop.hidden = false;

  // The prompt and the pack live in a header that never scrolls, so a six-zombie
  // fight with eight cards scrolls the cards and keeps the enemy in view.
  const head = windowHead(pop, el);
  if (head) {
    if (opts.pack) head.appendChild(packRow(opts.pack));
    if (prompt) {
      const p = document.createElement("p");
      p.className = "prompt";
      p.textContent = prompt;
      head.appendChild(p);
    }
  } else if (prompt) {
    const p = document.createElement("p");
    p.className = "prompt";
    p.textContent = prompt;
    el.appendChild(p);
  }

  // Lethal is judged against the health the player has right now, not the health
  // they had when the choice was assembled — cower can move it mid-window.
  const kills = (a) =>
    typeof opts.health === "number" &&
    a.cost &&
    typeof a.cost.hp === "number" &&
    a.cost.hp < 0 &&
    -a.cost.hp >= opts.health;

  actions.forEach((a, i) => {
    const fatal = kills(a);
    const b = document.createElement("button");
    b.type = "button";
    b.className =
      "action" +
      (a.primary ? " action--primary" : "") +
      (a.pivotal ? " action--pivotal" : "") +
      (fatal ? " action--lethal" : "");
    if (i < 9) {
      const k = document.createElement("kbd");
      k.textContent = String(i + 1);
      b.appendChild(k);
    }
    // Weapons and items already have art; a fight is far easier to read as a
    // row of weapons than as a row of sentences.
    const cut = a.icon ? a.icon.indexOf("-") : -1;
    const art = cut > 0 ? icon(a.icon.slice(0, cut), a.icon.slice(cut + 1), "action-icon") : null;
    if (art) b.appendChild(art);
    else if (a.dir) {
      const compass = document.createElement("span");
      compass.className = "action-compass";
      compass.setAttribute("aria-hidden", "true");
      compass.textContent = ARROW[a.dir] || "";
      b.appendChild(compass);
    }
    const text = document.createElement("span");
    text.className = "action-text";
    const name = document.createElement("span");
    name.className = "action-label";
    name.textContent = a.label;
    text.appendChild(name);
    // The consequence used to be bolted onto the end of the label. It is its own
    // field now, so it can be styled — and read out — as the separate thing it is.
    if (a.sub) {
      const sub = document.createElement("span");
      sub.className = "action-sub";
      sub.textContent = a.sub;
      text.appendChild(sub);
    }
    // The price, in hearts. Combat is fully deterministic, so there is nothing
    // to hide and no reason to make the player do the arithmetic.
    if (a.cost && typeof a.cost.hp === "number") {
      text.appendChild(fatal ? lethalRow() : costRow(a.cost.hp));
      b.appendChild(
        srOnly(
          fatal
            ? `${costSentence(a.cost.hp)} — this would kill you`
            : costSentence(a.cost.hp)
        )
      );
    }
    b.appendChild(text);
    if (a.kind) b.dataset.kind = a.kind;
    if (a.dir) b.dataset.dir = a.dir;
    b.disabled = !!a.disabled;
    b.addEventListener("click", a.onClick);
    el.appendChild(b);
  });
  bindActionKeys();
  // The window arriving is a card being turned over. Sound is not motion, so it
  // plays whether or not the pop-out animates.
  cardTurn();
  if (pop && !reducedMotion() && typeof pop.animate === "function") {
    pop.animate(
      [
        { opacity: 0, transform: "translateX(-50%) translateY(8px) scale(.97)" },
        { opacity: 1, transform: "translateX(-50%) translateY(0) scale(1)" },
      ],
      { duration: 150, easing: "cubic-bezier(.2,.8,.3,1)" }
    );
  }
  if (hadFocus || document.activeElement === document.body) {
    const first =
      el.querySelector(".action--primary:not(:disabled)") ||
      el.querySelector(".action:not(:disabled)");
    if (first) first.focus();
  }
}

// `actions` = [{label, onClick, primary?} | {label, href, primary?}].
// `opts` = { tone: "won" | "lost", summary: [string] }.
//
// The end of a run gets a beat before the verdict: the veil closes over about a
// second and a half, then the card arrives. Under reduced motion both land at
// once — the ceremony is the first thing to go, the information is not.
export function showOverlay(title, sub, actions = [], opts = {}) {
  // The end of a run is the one scene that does not need to hand the stage
  // back — the bars stay up under the veil until a new game clears them.
  enterScene();
  let ov = document.getElementById("overlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "overlay";
    document.body.appendChild(ov);
  }
  ov.innerHTML = "";
  ov.className = opts.tone ? `overlay--${opts.tone}` : "";
  ov.classList.toggle("overlay--still", reducedMotion());

  // The endings dress the stage differently before the card arrives. The win
  // gets the game's only sunrise; each loss dies its own death — combat is
  // violent (blood down the veil, a dragged handprint), health is quiet (a
  // pool rising while the vision closes), midnight is cold (no blood at all —
  // a cracked clock and the toll). Fixed drip positions rather than random
  // ones, per the house rule — the same ending should look the same twice.
  const reason = opts.tone === "lost" ? opts.reason || "combat" : null;
  if (reason) ov.classList.add(`overlay--lost-${reason}`);

  if (reason === "combat" && intense()) {
    const blood = document.createElement("div");
    blood.className = "blood";
    blood.setAttribute("aria-hidden", "true");
    // [left %, length px, fall seconds, delay seconds]
    const DRIPS = [
      [6, 300, 8, 1.3], [17, 180, 6.5, 2.2], [29, 380, 9.5, 1.1],
      [43, 220, 7, 3], [58, 330, 8.5, 1.7], [72, 190, 6, 2.6],
      [86, 280, 7.5, 2], [95, 150, 5.5, 3.3],
    ];
    for (const [x, len, dur, delay] of DRIPS) {
      const d = document.createElement("span");
      d.className = "drip";
      d.style.left = `${x}%`;
      d.style.setProperty("--len", `${len}px`);
      d.style.setProperty("--dur", `${dur}s`);
      d.style.setProperty("--delay", `${delay}s`);
      blood.appendChild(d);
    }
    ov.appendChild(blood);
    const hand = icon("verdict", "hand", "verdict-hand");
    if (hand) {
      hand.setAttribute("viewBox", "0 0 90 130"); // not on the 24 grid
      ov.appendChild(hand);
    }
  } else if (reason === "health") {
    // No violence — the wounds were already taken. The dark just rises.
    const pool = document.createElement("div");
    pool.className = "pool";
    pool.setAttribute("aria-hidden", "true");
    ov.appendChild(pool);
  }

  const card = document.createElement("div");
  card.className = "overlay-card";
  if (opts.tone === "won") {
    const scene = icon("verdict", "dawn", "verdict-scene");
    if (scene) {
      scene.setAttribute("viewBox", "0 0 240 120"); // a film frame, not the 24 grid
      card.appendChild(scene);
    }
  }
  if (reason === "midnight") {
    // The clock that killed you, stopped where it caught you, still tolling.
    const wrap = document.createElement("div");
    wrap.className = "tollwrap";
    wrap.setAttribute("aria-hidden", "true");
    const clock = icon("verdict", "midnight", "verdict-midnight");
    if (clock) {
      clock.setAttribute("viewBox", "0 0 96 96");
      wrap.appendChild(clock);
      card.appendChild(wrap);
    }
  }
  const h = document.createElement("h2");
  h.textContent = title;
  card.appendChild(h);
  const p = document.createElement("p");
  p.textContent = sub || "";
  card.appendChild(p);

  // Above the rows, because it is the thing worth reading. The seed sits below
  // both: the sentence is the bait and the seed is the share.
  if (opts.epilogue) {
    const line = document.createElement("p");
    line.className = "verdict-epilogue";
    line.textContent = opts.epilogue;
    card.appendChild(line);
  }

  if (opts.summary && opts.summary.length) {
    const list = document.createElement("ul");
    list.className = "verdict-summary";
    for (const line of opts.summary) {
      const li = document.createElement("li");
      li.textContent = line;
      list.appendChild(li);
    }
    card.appendChild(list);
  }

  for (const a of actions) {
    const cls = "btn" + (a.primary ? " btn--primary" : "");
    let el;
    if (a.href) {
      el = document.createElement("a");
      el.href = a.href;
    } else {
      el = document.createElement("button");
      el.type = "button";
      el.addEventListener("click", (e) => a.onClick(e.currentTarget));
    }
    el.className = cls;
    el.textContent = a.label;
    card.appendChild(el);
  }

  ov.appendChild(card);
  ov.hidden = false;
  const focusMe = ov.querySelector(".btn--primary") || ov.querySelector(".btn");
  if (focusMe) focusMe.focus();
}

export function hideOverlay() {
  const ov = document.getElementById("overlay");
  if (ov) ov.hidden = true;
}

// ---- name helpers ----------------------------------------------------------
export function tileName(game, id) {
  return (game.data.theme.tiles && game.data.theme.tiles[id]) || id;
}
export function itemName(game, id) {
  return (game.data.theme.items && game.data.theme.items[id]) || id;
}

function set(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

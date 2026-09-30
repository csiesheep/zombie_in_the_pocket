// Game page controller — orchestrates the turn sequence (spec §5), wiring user
// input -> engine + board -> render. Owns the RNG seed and the interactive
// flow (rotation, item, combat, flee, cower, zombie-door choices).

import * as E from "./engine.js";
import * as Bd from "./board.js";
import { combatHit, isMuted, setMuted, isCalm, setCalm, relicFound, seamCross, verdictSting,
         startAmbience, stopAmbience, startMurmur, stopMurmur, unduck, stopScore } from "./audio.js";
import {
  renderHud,
  renderBoard,
  renderActions,
  caption,
  clearChoices,
  darkDoorBeat,
  breakInTelegraph,
  breakInCracks,
  breakInPressure,
  breakInReanchor,
  breakInCollapse,
  breakInClear,
  settleDust,
  phantom,
  candleGutter,
  standing,
  clearStage,
  mountFilmStock,
  buryBeat,
  cowerScene,
  damageCameFrom,
  showNote,
  resolveBeat,
  log,
  clearLog,
  showOverlay,
  hideOverlay,
  loadIcons,
  watchBoardSize,
  animateEntry,
  jumpScare,
  uiIcon,
  formatHour,
  tileName as tName,
  itemName as iName,
} from "./render.js";

import { registerWorker, wireFullscreen, keepAwake, wireSleep } from "./shell.js";
import { recordVerdict } from "./tally.js";
import { epilogue } from "./epilogue.js";
import { portalStart, portalResult, portalRestart, portalBeaconOnLeave } from "./portal.js"; // 遊戲路口 result reporting (a no-op without a gp_token)

// One platform round per run. startNewGame() is the only place a Game is
// built -- it is both the boot and the "new game" button -- so it is the whole
// lifecycle: the first run opens the round, every later one restarts it in a
// single request. Nothing is awaited, and without ?gp_token every call is a
// no-op.
const portal = { opened: false, live: false, key: null, n: 0 };
function portalBegin(key) {
  if (portal.key === key) return;
  const unfinished = portal.live;
  portal.key = key; portal.live = true;
  if (!portal.opened) { portal.opened = true; portalStart(); }
  else portalRestart(unfinished ? "abandon" : undefined);
}
function portalEnd(key, won) {
  if (portal.key !== key || !portal.live) return;
  portal.live = false;
  portalResult(won ? "win" : "lose");
}

const DIR_WORD = { N: "north", E: "east", S: "south", W: "west" };

// `no-cache` forces a revalidation rather than a blind cache hit: it still
// costs only a 304 when nothing changed, but it means a re-theme or a rules fix
// actually reaches players who already have the old data cached.
const FETCH_OPTS = { cache: "no-cache" };

async function loadData() {
  const [tiles, cards, items, theme] = await Promise.all(
    ["tiles", "cards", "items", "theme"].map((name) =>
      fetch(`data/${name}.json`, FETCH_OPTS).then((r) => {
        if (!r.ok) throw new Error(`data/${name}.json -> HTTP ${r.status}`);
        return r.json();
      })
    )
  );
  return { tiles, cards, items, theme };
}

class Game {
  constructor(data, opts = {}) {
    this.data = data;
    const seed = opts.seed ?? (Date.now() >>> 0);
    this.seed = seed;
    this.state = E.newGame(data, { seed });
    this.board = Bd.createBoard(data, { seed });
    this.fled = false;
    // Kept for the end-of-run verdict; the engine has no use for them.
    this.tally = { putDown: 0, found: 0 };
  }

  tileName(id) { return tName(this, id); }
  itemName(id) { return iName(this, id); }

  // Themed nouns, so nothing player-visible is hardcoded to one setting.
  word(key) { return (this.data.theme.words && this.data.theme.words[key]) || key; }

  // The flavour line for a card in the current hour band, if the skin has one.
  flavour(cardId) {
    const f = this.data.theme.cardFlavour;
    const byCard = f && f[cardId];
    return (byCard && byCard[E.bandKey(this.state)]) || null;
  }

  refresh() { renderHud(this); renderBoard(this); }

  start() {
    E.beginTurn(this.state);
    this.refresh();
    clearLog();
    log(
      `You wake in the ${this.tileName("foyer")}. Find the ${this.word("relic")}, ` +
        `bury it in the ${this.tileName("graveyard")} before midnight.`
    );
    this.renderMoves();
  }

  // ---- Step 1: choose a move (mandatory) -----------------------------------
  renderMoves() {
    if (this.state.status !== "playing") return this.gameOver();
    const moves = Bd.listMoves(this.board);
    if (!moves.length) {
      log("Nowhere left to go…", "bad");
      return this.zombieDoorPhase(() => this.endTurn());
    }
    const acts = moves.map((m) => {
      if (m.type === "explore") {
        return { kind: "move", dir: m.dir, label: `Go ${m.dir} — explore`, sub: "unexplored",
          primary: true, onClick: () => this.doExplore(m.dir) };
      }
      if (m.type === "outside") {
        return { kind: "move", dir: m.dir, label: "Step outside (the arrow door)", sub: "the way out",
          primary: true, onClick: () => this.doOutside(m.dir) };
      }
      const to = this.board.worlds[m.to.world].get(Bd.cellKey(m.to.x, m.to.y));
      return { kind: "move", dir: m.dir, label: `Go ${m.dir} — ${this.tileName(to.id)}`,
        icon: `tile-${to.id}`, onClick: () => this.doMove(m.dir) };
    });
    renderActions(acts, "Choose a way out — you must move.");
  }


  // The tile turns itself. board.pickExploreRotation prefers a placement that
  // keeps a way on into unexplored space, and is deterministic so a shared seed
  // still replays move for move.
  doExplore(dir) {
    const revealed = this.board.decks[this.board.player.world][0];
    const rot = Bd.pickExploreRotation(this.board, dir);
    const r = Bd.explore(this.board, dir, rot);
    if (!r.ok) return this.renderMoves();
    log(`You reveal the ${this.tileName(revealed)} and step inside.`);

    // The engine has already placed the room. What waits is the sight of it:
    // the door opens onto black, holds, and only then does the light get there.
    // Choices go first, so a mashed key during the beat finds nothing — the
    // same rule the scare and the resolution beat follow.
    clearChoices();
    darkDoorBeat(dir, E.dread(this.state)).then(() => {
      this.refresh();
      animateEntry(dir);
      this.arriveAndDraw();
    });
  }

  doMove(dir) {
    // Crossing the seam is a move like any other to the board, but it is the
    // one that changes world — worth hearing, in both directions.
    const from = Bd.currentTile(this.board).world;
    Bd.moveTo(this.board, dir);
    if (Bd.currentTile(this.board).world !== from) seamCross();
    log(`You move to the ${this.tileName(Bd.currentTile(this.board).id)}.`);
    this.refresh();
    animateEntry(dir);
    this.arriveAndDraw();
  }

  doOutside(dir) {
    Bd.goOutside(this.board);
    seamCross();
    log(`You step out onto the ${this.tileName("patio")}. Night air, and worse.`);
    this.refresh();
    if (dir) animateEntry(dir);
    this.arriveAndDraw();
  }

  // ---- Steps 3–4: draw and resolve a development card ----------------------
  arriveAndDraw() {
    const c = E.drawCard(this.state);
    if (this.state.status !== "playing" || c == null) return this.gameOver();
    this.refresh();
    this.presentCard(c, { second: false });
  }

  presentCard(cardId, ctx) {
    const o = this.state.cardsById[cardId][E.bandKey(this.state)];
    const flavour = this.flavour(cardId);
    // Promoted rather than dropped: this is the only writing in the game, and
    // nothing else on screen carries it.
    if (flavour) { log(flavour); caption(flavour); }

    // If this room has no way on, the risen are already at a particular wall,
    // and the board knows which — isDeadEnd and pickZombieDoorWall are pure
    // reads, so the answer exists before the fight does. Say it now, while the
    // card is still being read, so the break-in is heard coming rather than
    // merely happening. Nothing here changes state.
    if (Bd.isDeadEnd(this.board)) {
      const wall = Bd.pickZombieDoorWall(this.board);
      // Stage one of the staged failure: a knock, and then a harder one. The
      // sequence owner handles the second — from here it is still one call.
      if (wall) breakInTelegraph(wall);
    }

    if (o.t === "EVENT") {
      E.changeHealth(this.state, o.hp || 0);
      if (o.hp) log(`${o.hp > 0 ? "+" : ""}${o.hp} HP.`, o.hp > 0 ? "good" : "bad");
      this.refresh();
      if (this.state.status === "lost") return this.gameOver();
      return this.proceed(ctx);
    }

    if (o.t === "ZOMBIES") {
      return this.presentCombat(o.n, () => this.proceed(ctx), { allowFlee: true });
    }

    // ITEM
    renderActions(
      [
        {
          kind: "item",
          label: "Search for the item",
          sub: "costs the next card",
          primary: true,
          onClick: () => {
            const c = E.drawCard(this.state);
            if (this.state.status !== "playing" || c == null) return this.gameOver();
            const item = this.state.cardsById[c].item;
            this.takeItemFlow(item, () => this.proceed(ctx));
          },
        },
        { kind: "item", label: "Leave it", sub: "no cost", onClick: () => this.proceed(ctx) },
      ],
      "Worth the time to grab it?"
    );
  }

  // ---- Combat (shared by card monsters and zombie doors) -------------------
  presentCombat(n, onDone, opts = {}) {
    const s = this.state;
    const foes = this.word("monsters");
    const usable = E.usableWeapons(s);
    const acts = [];

    if (usable.length > 1) {
      for (const w of usable) {
        acts.push({
          kind: "fight",
          icon: `item-${w}`,
          label: this.itemName(w),
          sub: `atk ${E.RULES.START_ATTACK + s.itemsById[w].attack}`,
          // combatDamage is what resolveCombat will call, clamp and all — never
          // a second copy of the formula sitting in the UI.
          cost: { hp: -E.combatDamage(n, E.RULES.START_ATTACK + s.itemsById[w].attack) },
          primary: true,
          onClick: () => this.doFight(n, w, onDone),
        });
      }
    } else {
      const best = E.chooseWeapon(s);
      acts.push({
        kind: "fight",
        icon: best ? `item-${best}` : null,
        label: `Fight ${n} ${foes}`,
        sub: best ? `with the ${this.itemName(best)}, atk ${E.effectiveAttack(s)}` : "bare-handed",
        cost: { hp: -E.combatDamage(n, E.effectiveAttack(s)) },
        primary: true,
        onClick: () => this.doFight(n, null, onDone),
      });
    }

    if (opts.allowFlee !== false) {
      const dests = Bd.listMoves(this.board).filter((m) => m.type === "move" || m.type === "cross");
      for (const d of dests) {
        const to = this.board.worlds[d.to.world].get(Bd.cellKey(d.to.x, d.to.y));
        acts.push({ kind: "flee", dir: d.dir, icon: `tile-${to.id}`,
          label: `Flee ${d.dir} to the ${this.tileName(to.id)}`,
          cost: { hp: -E.RULES.RUN_AWAY_DAMAGE },
          onClick: () => this.doFlee(d, false, onDone) });
        if (s.items.includes("oil")) {
          acts.push({
            kind: "flee",
            dir: d.dir,
            icon: "item-oil",
            label: `Flee ${d.dir} — throw the ${this.itemName("oil")}`,
            cost: { hp: 0 },
            onClick: () => this.doFlee(d, true, onDone),
          });
        }
      }
    }

    for (const fuel of ["oil", "gasoline"]) {
      if (s.items.includes("candle") && s.items.includes(fuel)) {
        acts.push({
          kind: "fight",
          icon: `item-${fuel}`,
          label: `${this.itemName("candle")} + ${this.itemName(fuel)}`,
          sub: "burn them all",
          cost: { hp: 0 },
          onClick: () => this.doCombo(fuel, onDone, n),
        });
      }
    }

    const prompt = `${n} ${foes}! Your attack is ${E.effectiveAttack(s)}.`;

    // Clear first, then scare, then offer the choices. Emptying the list is what
    // makes the flash safe: the previous step's buttons are gone, so nothing can
    // be clicked and the global number keys have nothing to find while it plays.
    renderActions([]);
    // Stage two: the wall cracks as the sting lands. Only for the break-in —
    // this.breachDir is set by zombieDoorPhase and null for a card fight, and
    // the difference between "they are here" and "they came through THERE" is
    // the whole reason the stages exist.
    if (this.breachDir) breakInCracks(this.breachDir);
    // Sometimes the picture does not come. Seeded from its own stream, so a
    // shared run is startled in the same places — and the actions still land
    // after the beat either way, so the input gating is untouched.
    const silent = E.rollSilentScare(this.state);
    // A break-in scare comes through the wall it is breaking. A card fight
    // passes nothing and keeps the centred burst — that difference is the
    // point, so this must never be a default.
    jumpScare(n, silent, { from: this.breachDir || null }).then(() => {
      // Never leave the keyboard's default resting on a choice that kills while
      // a survivable one is on the table. The lethal card stays clickable — it
      // just stops being the thing you hit by reflex.
      const fatal = (a) => a.cost && a.cost.hp < 0 && -a.cost.hp >= s.health;
      const survivable = acts.find((a) => !fatal(a));
      if (survivable && acts.some((a) => a.primary && fatal(a))) {
        for (const a of acts) a.primary = false;
        survivable.primary = true;
      }
      // Explicitly not flooded: at this point the wall is still there, and the
      // whole point of the flood is that a moment later it is not.
      startMurmur(n, { flood: false });
      renderActions(acts, prompt, { pack: n, health: s.health });
      // Stage three: it keeps pounding while you decide. Mounted after the
      // choices, so a wall that is coming in is the last thing added and the
      // first thing the eye catches.
      if (this.breachDir) breakInPressure();
    });
  }

  doFight(n, weapon, onDone) {
    // If the risen broke in, the blow comes from that wall. Read once and
    // cleared: a stale direction would tilt the next card fight for no reason.
    damageCameFrom(this.breachDir || null);
    this.breachDir = null;
    // Which weapon actually swings, asked of the same picker resolveCombat uses
    // — and asked before it runs, since a chainsaw spends a use on the way
    // through. The auto-fight card passes null; it still has a weapon in hand.
    const swung = E.chooseWeapon(this.state, weapon);
    combatHit(n, swung);
    this.tally.putDown += n;
    const r = E.resolveCombat(this.state, n, { weapon });
    log(
      `You fight ${n} ${this.word("monsters")} — ${swung ? "with the " + this.itemName(swung) : "bare-handed"} — and take ${r.damage} damage.`,
      r.damage >= 3 ? "bad" : ""
    );
    // The engine is already done. What follows only delays the next render, so
    // the pack visibly goes down before the window moves on. Clearing the cards
    // first is what makes the pause safe: mashed number keys find nothing.
    stopMurmur();
    unduck();
    clearChoices();
    resolveBeat({ icon: swung ? `item-${swung}` : null }).then(() => {
      // refresh drives the hit flash, so the damage lands after the swing
      // rather than alongside it — and after the beat, never racing the veil.
      this.refresh();
      if (this.state.status === "lost") return this.gameOver();
      onDone();
    });
  }

  doFlee(move, useOil, onDone) {
    // The parting swipe comes from the door you are going through.
    damageCameFrom(move.dir);
    Bd.moveTo(this.board, move.dir);
    E.flee(this.state, { useOil });
    this.fled = true;
    log(
      useOil
        ? `You hurl the ${this.itemName("oil")} and slip away, unscathed.`
        : "You flee, taking a parting swipe (-1 HP)."
    );
    // Fleeing gets a lunge, not the full sequence — you did not kill anything,
    // and the walk into the next room is the beat that matters here.
    stopMurmur();
    unduck();
    breakInClear();
    clearChoices();
    resolveBeat({ mode: "flee" }).then(() => {
      this.refresh();
      animateEntry(move.dir);
      if (this.state.status === "lost") return this.gameOver();
      onDone();
    });
  }

  doCombo(fuel, onDone, n = 0) {
    E.useCandleCombo(this.state, fuel);
    this.tally.putDown += n;
    log(
      fuel === "oil"
        ? `You torch the room — every one of the ${this.word("monsters")} drops.`
        : "Whoomph — the room ignites. All clear.",
      "good"
    );
    stopMurmur();
    unduck();
    clearChoices();
    resolveBeat({ icon: `item-${fuel}` }).then(() => {
      this.refresh();
      onDone();
    });
  }

  // ---- Step 6: the tile's own instructions --------------------------------
  proceed(ctx) {
    if (this.state.status !== "playing") return this.gameOver();

    if (ctx && ctx.second) {
      const tile = Bd.currentTile(this.board);
      if (ctx.kind === "temple" && !this.fled && tile.def.onResolve === "SECOND_CARD_THEN_GAIN_TOTEM") {
        E.gainTotem(this.state);
        relicFound();
        log(`Among the bones, the ${this.word("relic")}. It is yours.`, "good");
      }
      if (ctx.kind === "graveyard" && !this.fled && this.state.totem) {
        E.buryTotem(this.state);
      }
      this.refresh();
      if (this.state.status === "won") return this.gameOver();
      return this.deadEndCheck();
    }

    return this.afterCardSpecial();
  }

  afterCardSpecial() {
    if (this.fled) return this.deadEndCheck();
    const onr = Bd.currentTile(this.board).def.onResolve;
    if (onr === "BONUS_ITEM") return this.offerBonusItem();
    if (onr === "SECOND_CARD_THEN_GAIN_TOTEM") {
      return this.drawSecond("temple", `You start searching the ${this.tileName("evil-temple")}…`);
    }
    if (onr === "SECOND_CARD_THEN_BURY_TOTEM") {
      return this.drawSecond("graveyard", "You break ground, and begin the burial…");
    }
    return this.deadEndCheck();
  }

  offerBonusItem() {
    renderActions(
      [
        {
          kind: "item",
          label: "Rummage for an item",
          sub: "costs the next card",
          primary: true,
          onClick: () => {
            const c = E.drawCard(this.state);
            if (this.state.status !== "playing" || c == null) return this.gameOver();
            this.takeItemFlow(this.state.cardsById[c].item, () => this.deadEndCheck());
          },
        },
        { kind: "item", label: "Leave empty-handed", sub: "no cost", onClick: () => this.deadEndCheck() },
      ],
      `The ${this.tileName("storage")} — worth a rummage?`
    );
  }

  // The Reliquary and Family Plot resolve a second card. The designer ruled the
  // gap between the two "behaves like an ordinary fresh turn", so you may cower
  // there — and that allowance is its own, separate from the end-of-turn one.
  drawSecond(kind, msg) {
    log(msg);
    E.openCowerWindow(this.state);
    this.promptSecondCard(kind);
  }

  promptSecondCard(kind) {
    if (this.state.status !== "playing") return this.gameOver();
    const acts = [
      {
        kind: "draw",
        // The two choices the whole run is for. A tier above primary, because
        // primary is also what "Next turn" gets.
        pivotal: true,
        icon: "ui-relic",
        label: kind === "graveyard" ? "Dig on — draw the burial card" : "Search on — draw the second card",
        sub: kind === "graveyard" ? "the burial itself" : "the search itself",
        primary: true,
        onClick: () => this.doDrawSecond(kind),
      },
    ];
    if (!(E.HOUSE_RULES.COWER_ONCE_PER_TURN && this.state.coweredThisTurn)) {
      acts.push({ kind: "rest", label: "Cower first", sub: "burns a card",
        cost: { hp: E.RULES.COWER_HEAL },
        onClick: () => this.doCowerBeforeSecond(kind) });
    }
    renderActions(acts, "One more card to face. Take a breath first?");
  }

  doCowerBeforeSecond(kind) {
    const r = E.cower(this.state);
    if (!r.ok) return this.promptSecondCard(kind);
    log("You hole up and breathe. +3 HP — a card slips away unseen.", "good");
    clearChoices();
    const outdoors = Bd.currentTile(this.board).world === "outdoor";
    cowerScene(outdoors).then(() => {
      this.refresh();
      // Burning that card can empty the deck, turn the hour, and even end the run.
      if (this.state.status !== "playing") return this.gameOver();
      this.promptSecondCard(kind);
    });
  }

  doDrawSecond(kind) {
    // The staging wraps the draw; the draw itself is unchanged. Choices go
    // first so a mashed key during the digging finds nothing — and the cower
    // choice is untouched, because it was offered and taken before this point.
    clearChoices();
    buryBeat(kind).then(() => {
      const c = E.drawCard(this.state);
      if (this.state.status !== "playing" || c == null) return this.gameOver();
      this.refresh();
      // If the card is the risen, the scare lands mid-dig, which is the best
      // timing this game has to offer and costs nothing to arrange.
      this.presentCard(c, { second: true, kind });
    });
  }

  takeItemFlow(item, done) {
    if (E.hasItemSpace(this.state)) {
      E.pickUpItem(this.state, item);
      this.tally.found += 1;
      log(`You take the ${this.itemName(item)}.`, "good");
      this.refresh();
      return done();
    }
    const acts = this.state.items.map((held) => ({
      kind: "item",
      icon: `item-${item}`,
      sub: `lose the ${this.itemName(held)}`,
      label: `Drop ${this.itemName(held)}, take ${this.itemName(item)}`,
      onClick: () => {
        E.pickUpItem(this.state, item, held);
        this.tally.found += 1;
        log(`Dropped the ${this.itemName(held)}, took the ${this.itemName(item)}.`);
        this.refresh();
        done();
      },
    }));
    acts.push({ kind: "item", label: `Leave the ${this.itemName(item)}`, sub: "keep what you carry", onClick: done });
    renderActions(acts, `Your hands are full. Make room for the ${this.itemName(item)}?`);
  }

  // ---- Step 7: dead-end / zombie door -------------------------------------
  deadEndCheck() {
    if (this.state.status !== "playing") return this.gameOver();
    this.refresh();
    if (Bd.isDeadEnd(this.board)) return this.zombieDoorPhase(() => this.endTurn());
    // The one place a phantom can fire: the card is done, no fight is coming,
    // and the turn is about to hand back. Rolled at a fixed point in the turn
    // rather than on a timer, because a shared seed has to hear the same house
    // — and never while something real is happening, because a false cue is
    // only worth anything when the honest ones are unambiguous.
    // Not rolled at all in calm mode rather than rolled and discarded: the
    // stream stays where it was, so switching calm on and off mid-run does not
    // change what a seed does afterwards.
    if (!isCalm()) {
      const fear = E.dread(this.state);
      const dir = E.rollPhantom(this.state, fear);
      if (dir) phantom(dir);
      // The candle fails on its own schedule, and always when a phantom fires:
      // the two together are one event — something moved, and the light went
      // with it — where separately they are two effects.
      if (dir || E.rollGutter(this.state, fear)) candleGutter();
      // Once a run at the outside, and never on the same beat as a phantom:
      // two unexplained things at once is a haunting, and one is a doubt.
      if (!dir && E.rollStanding(this.state, fear)) standing();
    }
    return this.endTurn();
  }

  zombieDoorPhase(onDone) {
    log(`Dead end. Three of the ${this.word("monsters")} claw at the walls…`, "bad");
    // The hole is punched after the fight, not before, because where it lands
    // depends on how the fight ends: stand your ground and they come through a
    // wall of this room; run and they follow, and break into the room you
    // reached instead.
    const cameFrom = Bd.currentTile(this.board);
    // Which wall they are working on. Known before the fight because
    // pickZombieDoorWall is a pure read — the same look-ahead the telegraph
    // uses — and it is what leans the damage flash toward them.
    this.breachDir = Bd.pickZombieDoorWall(this.board);
    this.presentCombat(
      E.RULES.ZOMBIE_DOOR_COUNT,
      () => {
        this.breakInWall(cameFrom);
        onDone();
      },
      { allowFlee: true }
    );
  }

  breakInWall(cameFrom) {
    breakInClear(); // whatever was pounding, stop pounding
    if (this.state.status !== "playing") return;
    const here = Bd.currentTile(this.board);
    // Compared by tile rather than this.fled, which may already be set from an
    // earlier retreat in the same turn.
    const ran = here !== cameFrom;
    // Favours a wall opening onto unexplored space: the hole persists and is
    // how you get out, so one facing tiles already placed would only lead back.
    const wall = Bd.pickZombieDoorWall(this.board);
    if (!wall) return; // nothing blank left to break through
    Bd.openZombieDoor(this.board, wall);
    this.refresh();
    log(
      ran
        ? `They follow you in through the ${DIR_WORD[wall]} wall of the ${this.tileName(here.id)}.`
        : `They come through the ${DIR_WORD[wall]} wall.`,
      "bad"
    );
    // Stage four, or five. Standing your ground collapses the wall that has
    // been cracking all fight. Running means the prediction was wrong and the
    // whole sequence has to move: a fast knock and a crack in the room you
    // actually reached, and then the collapse there. The board already decides
    // where the hole goes; the staging follows it rather than the other way
    // round.
    if (ran) breakInReanchor(wall).then(() => breakInCollapse(wall));
    else breakInCollapse(wall);
  }

  // ---- Steps 8–9: end of turn (heal, cower) -------------------------------
  endTurn() {
    if (this.state.status !== "playing") return this.gameOver();
    const tile = Bd.currentTile(this.board);
    if (!this.fled && tile.def.onTurnEnd === "HEAL_1") {
      E.changeHealth(this.state, 1);
      // A room that heals is the game's other "not this time", so it buys the
      // same turn of release a survived fight does. Slightly less of one: it is
      // a kitchen, not an escape.
      E.grantRelief(this.state, 0.7);
      log(`You steady yourself here. +1 HP.`, "good");
      this.refresh();
    }
    // Step 9 gets its own cower allowance, independent of one taken between a
    // Reliquary / Family Plot pair.
    E.openCowerWindow(this.state);
    this.renderEndTurn();
  }

  // Split out from endTurn so cowering can re-render the choices without
  // re-running step 8 — which would hand out the Kitchen / Herb Garden heal a
  // second time.
  renderEndTurn() {
    const acts = [{ kind: "draw", label: "Next turn", sub: "press on", primary: true, onClick: () => this.nextTurn() }];
    if (!(E.HOUSE_RULES.COWER_ONCE_PER_TURN && this.state.coweredThisTurn)) {
      acts.unshift({ kind: "rest", label: "Cower", sub: "burns a card",
        cost: { hp: E.RULES.COWER_HEAL }, onClick: () => this.doCower() });
    }
    renderActions(acts, "The room is quiet. Rest, or press on?");
  }

  doCower() {
    const r = E.cower(this.state);
    if (!r.ok) return this.renderEndTurn();
    log("You hole up and breathe. +3 HP — a card slips away unseen.", "good");
    // The engine has already resolved: the card is spent and the health is
    // banked. What follows is the hour you spent in the corner, and the health
    // is only shown on the way out of it, with the exhale.
    clearChoices();
    const outdoors = Bd.currentTile(this.board).world === "outdoor";
    cowerScene(outdoors).then(() => {
      this.refresh();
      if (this.state.status === "lost") return this.gameOver();
      this.renderEndTurn();
    });
  }

  nextTurn() {
    // A turn later, the dust in last turn's hole has settled. The gouges and
    // the dark stay — those are what the house keeps.
    settleDust();
    E.beginTurn(this.state);
    this.fled = false;
    this.refresh();
    this.renderMoves();
  }

  // ---- End states ----------------------------------------------------------
  gameOver() {
    this.refresh();
    renderActions([]);
    // A run that ended mid-break-in must not leave a wall pounding under the
    // verdict card.
    breakInClear();
    // The house stops breathing when the run does. Both beds go before the
    // verdict sting, so the ending has the room to itself.
    stopMurmur();
    unduck();
    stopAmbience();
    keepAwake(false);
    // The verdicts carry their own stings; the score is never played over them.
    stopScore();
    const won = this.state.status === "won";

    // Counted once, and the guard is load-bearing: the win path re-enters
    // gameOver after the silent beat below, so without it every escape would
    // be recorded twice and every one of those runs would look like two.
    if (!this.tallied) {
      this.tallied = true;
      recordVerdict(won);
      // Same guard, same reason: the win path re-enters gameOver, and a result
      // may only be reported once. tally.js keeps no score, so none is sent.
      portalEnd(this.pkey, won);
    }

    // A win is always a burial — buryTotem is the only thing that sets it — so
    // this is the moment the digging has been building to. One silent beat
    // before the dawn: the release is the silence, not the sting.
    if (won && !this.verdictHeld) {
      this.verdictHeld = true;
      return void setTimeout(() => this.gameOver(), 700);
    }
    verdictSting(won);

    const again = [
      { label: "Play again", primary: true, onClick: () => startNewGame() },
      { label: "Replay this seed", onClick: () => startNewGame(this.seed) },
      // A finished run is exactly when someone wants to hand the seed on.
      { label: "Copy replay link", onClick: (btn) => copyReplayLink(btn) },
      { label: "Menu", href: "index.html" },
    ];

    const summary = [
      `Lasted until ${formatHour(this.state.hour)}`,
      `${this.tally.putDown} of the ${this.word("monsters")} put down`,
      `${this.tally.found} ${this.tally.found === 1 ? "item" : "items"} found`,
      won
        ? `The ${this.word("relic")} is buried`
        : this.state.totem
          ? `The ${this.word("relic")} was on you, unburied`
          : `The ${this.word("relic")} was never found`,
      `Seed ${this.seed}`,
    ];

    // The sentence somebody might actually screenshot, above the rows nobody
    // does. Composed here so both verdicts get it from one place.
    const closing = epilogue(this);

    if (won) {
      showOverlay(
        "You made it to dawn",
        `The ${this.word("relic")} is buried. The house falls silent.`,
        again,
        { tone: "won", summary, epilogue: closing }
      );
      return;
    }
    const why = {
      combat: "The dead pulled you under.",
      health: "Your wounds were too deep.",
      midnight: "The bell tolls midnight, and the house keeps you.",
    };
    showOverlay(
      this.state.lossReason === "midnight" ? "Midnight" : "You are one of them now",
      why[this.state.lossReason] || "Game over.",
      again,
      { tone: "lost", reason: this.state.lossReason, summary, epilogue: closing }
    );
  }
}

// ---- Page-level state ------------------------------------------------------
// `data` is fetched once; every run after the first reuses it, so restarting is
// synchronous and needs no reload.
let data = null;
let game = null;

function startNewGame(seed) {
  hideOverlay();
  clearStage();
  // A run is in progress: the screen stays lit. Released at the verdict, so a
  // finished game is not quietly holding the phone awake.
  keepAwake(true);
  // A new run gets the wind back, and never a second copy of it — startAmbience
  // is idempotent, so restarting mid-run is safe.
  stopMurmur();
  startAmbience();
  game = new Game(data, seed != null ? { seed } : {});
  game.pkey = "run:" + ++portal.n;
  portalBegin(game.pkey);
  window.__game = game; // handy for debugging
  const el = document.getElementById("seed-value");
  if (el) el.textContent = game.seed;
  game.start();
}

function seedFromUrl() {
  const raw = new URLSearchParams(location.search).get("seed");
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n >>> 0 : null;
}

// ---- Run controls ----------------------------------------------------------
async function copyReplayLink(btn) {
  btn = btn || document.getElementById("btn-copy-seed");
  const url = `${location.origin}${location.pathname}?seed=${game.seed}`;
  try {
    await navigator.clipboard.writeText(url);
    const was = btn.title || btn.textContent;
    if (btn.title) {
      btn.title = "Link copied";
      btn.classList.add("utilbtn--done");
      setTimeout(() => {
        btn.title = was;
        btn.classList.remove("utilbtn--done");
      }, 1800);
    } else {
      btn.textContent = "Link copied";
      setTimeout(() => (btn.textContent = was), 1800);
    }
  } catch {
    // Clipboard refused (insecure context or denied permission) — put the link
    // in the log so it can still be copied by hand.
    log("Replay link: " + url);
  }
}

// The toggle carries the state, not just a label: a button reading "Mute" tells
// you nothing about whether sound is currently on.
// The way out of the horror, for players who want the game without it. Sits
// next to Sound because they are the same kind of decision — how loud should
// this be at me — and it is a separate switch from the OS motion setting on
// purpose: wanting animation and not wanting to be frightened are different.
// First run only. The key is the whole mechanism: no zitp:seen means nobody has
// played here before.
//
// Off the RNG entirely — showing the note is presentation, so a shared seed
// plays out identically whether or not the note appeared. That matters more
// than it looks: reading the note takes time, and time is exactly what this
// game measures, so it must not be allowed to cost any.
const SEEN_KEY = "zitp:seen";

function firstVisit() {
  try {
    return localStorage.getItem(SEEN_KEY) !== "1";
  } catch {
    return false; // storage blocked: do not ambush a returning player every run
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* they will be offered it again; the button in the corner still works */
  }
}

function openNote() {
  const note = data && data.theme && data.theme.note;
  if (!note) return;
  showNote(note, markSeen);
}

function paintCalmToggle() {
  const btn = document.getElementById("btn-calm");
  if (!btn) return;
  const on = isCalm();
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  const label = document.getElementById("calm-label");
  if (label) label.textContent = on ? "Calm mode on" : "Calm mode off";
  const slot = document.getElementById("calm-icon");
  if (slot) {
    slot.textContent = "";
    const art = uiIcon("calm", "utilicon-svg");
    if (art) slot.appendChild(art);
  }
  document.body.classList.toggle("calm", on);
}

function paintSoundToggle() {
  const btn = document.getElementById("btn-sound");
  if (!btn) return;
  const on = !isMuted();
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  const label = document.getElementById("sound-label");
  if (label) label.textContent = on ? "Sound on" : "Sound off";
  const slot = document.getElementById("sound-icon");
  if (slot) {
    slot.textContent = "";
    const art = uiIcon(on ? "sound-on" : "sound-off", "soundicon-svg");
    if (art) slot.appendChild(art);
  }
}

function paintCopyIcon() {
  const slot = document.getElementById("copy-icon");
  if (!slot || slot.childNodes.length) return;
  const art = uiIcon("copy", "soundicon-svg");
  if (art) slot.appendChild(art);
}

function wireControls() {
  document.getElementById("btn-copy-seed").addEventListener("click", () => copyReplayLink());
  document.getElementById("btn-sound").addEventListener("click", () => {
    setMuted(!isMuted());
    paintSoundToggle();
  });

  const noteBtn = document.getElementById("btn-note");
  if (noteBtn) noteBtn.addEventListener("click", openNote);

  const calmBtn = document.getElementById("btn-calm");
  if (calmBtn) {
    calmBtn.addEventListener("click", () => {
      setCalm(!isCalm());
      paintCalmToggle();
    });
  }
  // M is off the 1-9 action path on purpose, and ignored while typing.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "m" && e.key !== "M") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    setMuted(!isMuted());
    paintSoundToggle();
  });
  document.getElementById("btn-new-game").addEventListener("click", () => {
    // Drop ?seed= so a shared link doesn't silently reapply to the fresh run.
    if (location.search) history.replaceState(null, "", location.pathname);
    startNewGame();
  });
}

async function main() {
  try {
    // Icons are decorative, so a failed sprite must not block the game.
    [data] = await Promise.all([loadData(), loadIcons()]);
    wireControls();
  wireFullscreen();
  wireSleep();
  registerWorker();
    paintSoundToggle();
    paintCalmToggle();
    paintCopyIcon();
    // Size the board off its pane before the first render, and keep it sized as
    // the pane changes — the sidebar growing counts, not just the window.
    watchBoardSize();
    // Mounted once for the life of the page: the grain and the dust belong to
    // the pane, not to any particular run.
    mountFilmStock();
    startNewGame(seedFromUrl());
    // After the game is up, so the note is read over the Entry Hall rather
    // than over nothing.
    if (firstVisit()) openNote();
  } catch (err) {
    console.error(err);
    log("Failed to start the game — see console.", "bad");
  }
}

// Leaving the page mid-run reports the round as abandoned; a finished run has
// already been reported and sends nothing.
portalBeaconOnLeave(() => ({ outcome: "abandon" }));

main();

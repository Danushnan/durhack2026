/**
 * How Cars drive. Pure (no rendering, no three.js) so it can be stepped and checked in a test.
 *
 * Each Car follows the one ahead in its lane with the Intelligent Driver Model: it accelerates towards
 * its own cruising speed, slows for bends ahead, and brakes smoothly to keep a safe time gap, so a slow
 * or blocked service builds a real queue that ripples back up the Road. Each Car draws a number when
 * it leaves; against the callee's live refused and error rates that decides what happens at the door:
 *  - served  → it drives in and a ready Unit answers it;
 *  - error   → the service answers with an error after a wait;
 *  - refused → nobody is ready to answer, so the request fails immediately.
 * Both failures burst at the door before returning.
 */

export interface CarAgent {
  s: number          // distance travelled along its trip
  v: number          // speed
  v0: number         // this driver's cruising speed
  a: number          // last acceleration (negative = braking: brake lights on)
  slot: number       // which pooled mesh draws it
  phase: 'out' | 'in' | 'wait' | 'burst' | 'back'
  roll: number       // drawn when it leaves: below the refused rate it is refused, then errors, else served
  fate?: 'refused' | 'error'
  until: number      // when a waiting Car gets its error answer
}

export interface Trip {
  okLength: number              // out along the right lane and into the callee
  backLength: number            // out, U-turn at the door, back along the other lane
  vehicleLength?: number
  door: number                  // where a Car learns its fate
  limitOk: (s: number) => number   // the fastest a Car may take the bend at s
  limitBack: (s: number) => number
}

export const DRIVE = {
  speed: 7,        // typical cruising speed (world units per second)
  accel: 6,        // comfortable acceleration
  brake: 12,       // comfortable braking
  length: 1.1,     // a Car's length
  minGap: 0.9,     // bumper-to-bumper gap when stopped
  headway: 0.35,   // seconds of gap kept at speed
  wait: 1.1,       // seconds an Impacted service takes to answer with an error
  burst: 0.65,     // seconds the explosion plays before the return starts
}

/** Intelligent Driver Model acceleration, for a gap to (and the speed of) whatever is ahead. */
export function idm(v: number, v0: number, gap: number, vAhead: number): number {
  const free = 1 - (v / Math.max(v0, 0.1)) ** 4
  if (!Number.isFinite(gap)) return DRIVE.accel * free
  const wanted = DRIVE.minGap + Math.max(0, v * DRIVE.headway + (v * (v - vAhead)) / (2 * Math.sqrt(DRIVE.accel * DRIVE.brake)))
  return DRIVE.accel * (free - (wanted / Math.max(gap, 0.05)) ** 2)
}

/** The speed to aim for: the driver's own, capped by the tightest bend within braking distance. */
function target(c: CarAgent, limit: (s: number) => number) {
  const reach = (c.v * c.v) / (2 * DRIVE.brake) + 1
  return Math.min(c.v0, limit(c.s), limit(c.s + reach / 2), limit(c.s + reach))
}

function drive(c: CarAgent, dt: number, v0: number, gap: number, vAhead: number) {
  c.a = Math.max(-3 * DRIVE.brake, idm(c.v, v0, gap, vAhead))
  c.v = Math.max(0, c.v + c.a * dt)
  c.s += c.v * dt
}

/** A new Car leaving the caller, slowly at first. Each driver cruises a little faster or slower. */
export function newCar(slot: number, rand: () => number): CarAgent {
  return { s: 0, v: 2, v0: DRIVE.speed * (0.85 + 0.3 * rand()), a: 0, slot, phase: 'out', roll: rand(), until: 0 }
}

/** The caller's exit is clear enough for another Car to pull out. */
export const exitClear = (cars: CarAgent[], length = DRIVE.length) => !cars.some((c) => c.phase === 'out' && c.s < length + DRIVE.minGap)

// shortcut: one Car stands for ~11 requests. A caller's exit lets out ~1.2 Cars/s, so the demo's 8 req/s at the
// City Gate fills ~60% of it and rush hour (24 req/s) saturates it; rescale if request rates grow much larger.
export const CARS_PER_REQUEST = 0.09

/**
 * Requests waiting to leave as Cars accrue at the request rate; up to 3 wait while the caller's exit is
 * blocked (that backlog is a full Road). Returns the new backlog and whether a Car leaves now (jittered spacing).
 */
export function admit(credit: number, rps: number, dt: number, cars: CarAgent[], rand: () => number, density = CARS_PER_REQUEST, length = DRIVE.length) {
  credit = Math.min(3, credit + rps * density * dt)
  const leave = credit >= 1 && exitClear(cars, length)
  return { credit: leave ? credit - (0.6 + 0.8 * rand()) : credit, leave }
}

/** The callee right now: the share of requests nobody answers, and the share answered with an error. */
export interface Rates { refused: number; error: number }
const fateOf = (c: CarAgent, r: Rates) => (c.roll < r.refused ? 'refused' : c.roll < r.refused + r.error ? 'error' : undefined)

/**
 * Advance every Car by dt and report new explosions and completed deliveries.
 */
export function stepCars(cars: CarAgent[], dt: number, now: number, trip: Trip, rates: Rates) {
  const len = trip.vehicleLength ?? DRIVE.length
  let bursts = 0
  const burst = (car: CarAgent) => {
    car.phase = 'burst'
    car.until = now + DRIVE.burst
    car.s = trip.door
    car.v = 0
    car.a = 0
    bursts++
  }
  // Outbound lane, front to back: everything not yet turned back, including Cars waiting at the door.
  let ahead: { s: number; v: number } | null = null
  for (const c of cars.filter((c) => c.phase !== 'back').sort((a, b) => b.s - a.s)) {
    if (c.phase === 'burst') {
      if (now >= c.until) c.phase = 'back'
    } else if (c.phase === 'wait') {
      c.v = 0; c.a = 0
      if (now >= c.until) burst(c)
    } else {
      // An Impacted service makes Cars stop at its door (IDM keeps minGap, so the line sits just past it);
      // a refused Car slows for the U-turn it is about to make.
      const fate = c.phase === 'out' ? fateOf(c, rates) : undefined
      const stopLine = fate === 'error' ? trip.door + DRIVE.minGap + 0.2 - c.s : Infinity
      const gap = Math.min(ahead ? ahead.s - c.s - len : Infinity, stopLine)
      const vAhead = ahead && ahead.s - c.s - len <= stopLine ? ahead.v : 0
      drive(c, dt, target(c, fate === 'refused' ? trip.limitBack : trip.limitOk), gap, vAhead)
      if (c.phase === 'out' && c.s >= trip.door) {
        if (fate === 'refused') { c.fate = 'refused'; burst(c) }
        else if (fate === 'error') { c.phase = 'wait'; c.fate = 'error'; c.until = now + DRIVE.wait; c.s = Math.min(c.s, trip.door); c.v = 0 }
        else c.phase = 'in'
      }
    }
    ahead = c.phase === 'back' ? ahead : c
  }
  // Return lane, front to back.
  ahead = null
  for (const c of cars.filter((c) => c.phase === 'back').sort((a, b) => b.s - a.s)) {
    drive(c, dt, target(c, trip.limitBack), ahead ? ahead.s - c.s - len : Infinity, ahead?.v ?? 0)
    ahead = c
  }
  const done = cars.filter((c) => (c.phase === 'in' && c.s >= trip.okLength) || (c.phase === 'back' && c.s >= trip.backLength))
  return { bursts, served: done.filter((c) => c.phase === 'in'), cars: cars.filter((c) => !done.includes(c)) }
}

/**
 * Speed limit along a polyline from how sharply it turns: v = sqrt(lateral grip × radius).
 * Returns a lookup by distance travelled.
 */
export function bendLimit(pts: { x: number; z: number }[], grip = 10, top = 99): (s: number) => number {
  const at: number[] = [0], lim: number[] = []
  for (let i = 1; i < pts.length; i++) at.push(at[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z))
  for (let i = 0; i < pts.length; i++) {
    if (i === 0 || i === pts.length - 1) { lim.push(top); continue }
    const a = Math.atan2(pts[i].z - pts[i - 1].z, pts[i].x - pts[i - 1].x)
    const b = Math.atan2(pts[i + 1].z - pts[i].z, pts[i + 1].x - pts[i].x)
    const turn = Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)))
    const span = (at[i + 1] - at[i - 1]) / 2
    lim.push(turn < 1e-4 ? top : Math.min(top, Math.sqrt(grip * (span / turn))))
  }
  return (s: number) => {
    let i = 1
    while (i < at.length - 1 && at[i] < s) i++
    return Math.min(lim[i - 1], lim[i])
  }
}

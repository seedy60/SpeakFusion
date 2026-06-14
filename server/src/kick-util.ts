// Vote-to-kick for public rooms (no moderators — the room decides collectively).
//
// `kickThreshold(n)` is the single, pure source of truth for how many distinct
// voters must vote to remove ONE peer, given `n` = the number of "votable"
// (non-caster, human) peers currently in the room. The target IS counted in n.
//
// Vote-to-kick needs a real group: with only two people "majority" is incoherent
// (the lone other person would decide unilaterally), so it's disabled entirely
// for fewer than THREE votable peers — exactly like a private room (controls
// hidden, server rejects). From three up it's `ceil(n / 2)` ("at least half"):
//   - 0-2 people -> Infinity (no kick; same as a private room)
//   - 3 people   -> 2 votes
//   - 4 people   -> 2 votes
//   - 5 people   -> 3 votes
//   - 6 people   -> 3 votes
export function kickThreshold(votablePeerCount: number): number {
  if (votablePeerCount < 3) return Infinity;
  return Math.ceil(votablePeerCount / 2);
}

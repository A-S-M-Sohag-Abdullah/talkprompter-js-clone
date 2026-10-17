// A critically-damped spring (the well-known game-engine SmoothDamp). Eases a
// value toward a target without overshoot, turning the matcher's discrete
// position jumps into smooth, natural scrolling.
//
// `state.velocity` is carried between calls. Returns the new value.
export function smoothDamp(current, target, state, smoothTime, deltaTime, maxSpeed = Infinity) {
  smoothTime = Math.max(0.0001, smoothTime);
  const omega = 2 / smoothTime;
  const x = omega * deltaTime;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

  let change = current - target;
  const originalTo = target;
  const maxChange = maxSpeed * smoothTime;
  change = Math.min(maxChange, Math.max(-maxChange, change));

  const temp = (state.velocity + omega * change) * deltaTime;
  state.velocity = (state.velocity - omega * temp) * exp;
  let result = (current - change) + (change + temp) * exp;

  // Prevent overshooting past the target.
  if ((originalTo - current > 0) === (result > originalTo)) {
    result = originalTo;
    state.velocity = 0;
  }
  return result;
}

import { animated, useReducedMotion, useSpring } from "@react-spring/web";

export function MainPanelZeroState() {
  const reduceMotion = useReducedMotion();

  const driftSpring = useSpring({
    from: { progress: 0, opacity: 0.34 },
    to: reduceMotion
      ? { progress: 0.06, opacity: 0.38 }
      : async (next) => {
          while (true) {
            await next({ progress: 1, opacity: 0.42 });
            await next({ progress: 0, opacity: 0.34 });
          }
        },
    config: {
      tension: 12,
      friction: 24,
      duration: 22000,
    },
    immediate: Boolean(reduceMotion),
  });

  const foldSpring = useSpring({
    from: { progress: 0.24, opacity: 0.28 },
    to: reduceMotion
      ? { progress: 0.3, opacity: 0.32 }
      : async (next) => {
          while (true) {
            await next({ progress: 1.24, opacity: 0.38 });
            await next({ progress: 0.24, opacity: 0.28 });
          }
        },
    config: {
      tension: 11,
      friction: 22,
      duration: 26000,
    },
    immediate: Boolean(reduceMotion),
  });

  const sweepSpring = useSpring({
    from: { progress: 0.46, opacity: 0.24 },
    to: reduceMotion
      ? { progress: 0.5, opacity: 0.28 }
      : async (next) => {
          while (true) {
            await next({ progress: 1.46, opacity: 0.34 });
            await next({ progress: 0.46, opacity: 0.24 });
          }
        },
    config: {
      tension: 10,
      friction: 24,
      duration: 30000,
    },
    immediate: Boolean(reduceMotion),
  });

  return (
    <section className="main-panel-zero panel" aria-label="Library stage idle state">
      <div className="main-panel-zero__visual" aria-hidden="true">
        <animated.div
          className="main-panel-zero__layer main-panel-zero__layer--sheet-a"
          style={{
            opacity: driftSpring.opacity,
            transform: driftSpring.progress.to((progress) => {
              const angle = progress * Math.PI * 2;
              const x = Math.cos(angle) * 4;
              const y = Math.sin(angle) * 3;
              const rotate = Math.sin(angle) * 3;
              const skew = Math.cos(angle * 1.5) * 4;
              const scaleY = 1 + Math.sin(angle * 2) * 0.04;
              return `translate3d(${x}%, ${y}%, 0) rotate(${rotate}deg) skewX(${skew}deg) scaleY(${scaleY})`;
            }),
          }}
        />
        <animated.div
          className="main-panel-zero__layer main-panel-zero__layer--sheet-b"
          style={{
            opacity: foldSpring.opacity,
            transform: foldSpring.progress.to((progress) => {
              const angle = progress * Math.PI * 2;
              const x = Math.cos(angle) * -3;
              const y = Math.sin(angle) * 4;
              const rotate = -8 + Math.sin(angle) * 4;
              const skew = Math.sin(angle * 1.5) * -5;
              const scaleX = 1 + Math.cos(angle * 2) * 0.05;
              return `translate3d(${x}%, ${y}%, 0) rotate(${rotate}deg) skewY(${skew}deg) scaleX(${scaleX})`;
            }),
          }}
        />
        <animated.div
          className="main-panel-zero__layer main-panel-zero__layer--sheet-c"
          style={{
            opacity: sweepSpring.opacity,
            transform: sweepSpring.progress.to((progress) => {
              const angle = progress * Math.PI * 2;
              const x = Math.cos(angle) * 5;
              const y = Math.sin(angle) * -3;
              const rotate = 5 + Math.cos(angle) * 3;
              const skew = Math.sin(angle * 2) * 3;
              const scaleY = 1 + Math.cos(angle * 1.5) * 0.06;
              return `translate3d(${x}%, ${y}%, 0) rotate(${rotate}deg) skewX(${skew}deg) scaleY(${scaleY})`;
            }),
          }}
        />
        <div className="main-panel-zero__mesh" />
      </div>

      <div className="main-panel-zero__content">
        <p className="eyebrow">Main Stage</p>
        <h2>Signal Awaits</h2>
        <p>Select an artist, album, or track to bring the stage online.</p>
      </div>
    </section>
  );
}

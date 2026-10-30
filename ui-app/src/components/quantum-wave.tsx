import { useEffect, useRef } from "react";

/** Browser-only, local audio visualisation; no recordings or network requests. */
export function QuantumWave({ level, listening }: { level: number; listening: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audio = useRef({ level, listening });
  audio.current = { level, listening };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const css = getComputedStyle(canvas);
    const ink = css.getPropertyValue("--wave-ink").trim();
    const light = css.getPropertyValue("--wave-light").trim();
    const silver = css.getPropertyValue("--wave-silver").trim();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let smooth = 0;
    let time = 0;
    const draw = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      smooth += (audio.current.level - smooth) * .12;
      time += reduced ? .002 : .009 + smooth * .016;
      canvas.dataset["level"] = smooth.toFixed(3);
      const cx = w / 2, cy = h * .5;
      const r = Math.min(w * .29, h * .3) * (1 + smooth * .15);

      // A floating liquid lens: many concentric, deformed specular contours.
      const fill = ctx.createRadialGradient(cx - r * .2, cy - r * .3, 1, cx, cy, r);
      fill.addColorStop(0, light); fill.addColorStop(.45, silver); fill.addColorStop(.76, ink); fill.addColorStop(1, light);
      ctx.globalAlpha = .15;
      ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(cx, cy, r * .93, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      for (let ring = 0; ring < 65; ring++) {
        const fraction = ring / 65;
        ctx.beginPath();
        for (let i = 0; i <= 220; i++) {
          const a = i / 220 * Math.PI * 2;
          const base = r * (.17 + fraction * .83);
          const ripple = Math.sin(a * 3 + time * 1.3 + fraction * 8) * (.045 + smooth * .1)
            + Math.sin(a * 7 - time + fraction * 11) * (.018 + smooth * .03);
          const radius = base * (1 + ripple);
          const x = cx + Math.cos(a) * radius;
          const y = cy + Math.sin(a) * radius * (.88 + .09 * Math.sin(time + fraction * 3));
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.strokeStyle = ring % 4 === 0 ? light : ring % 3 === 0 ? silver : ink;
        ctx.globalAlpha = .2 + fraction * .52; ctx.lineWidth = ring % 4 === 0 ? 1.6 : .65; ctx.stroke();
      }
      // Orbital telemetry and the equatorial audio waveform.
      ctx.globalAlpha = .5; ctx.strokeStyle = ink; ctx.lineWidth = .7;
      for (let orbit = 0; orbit < 3; orbit++) {
        const rotation = orbit * .9 + time * .12;
        ctx.beginPath(); ctx.ellipse(cx, cy, r * 1.34, r * .46, rotation, 0, Math.PI * 2); ctx.stroke();
        const a = time * (.6 + orbit * .14) + orbit * 2;
        const x = Math.cos(a) * r * 1.34, y = Math.sin(a) * r * .46;
        ctx.beginPath(); ctx.arc(cx + x * Math.cos(rotation) - y * Math.sin(rotation), cy + x * Math.sin(rotation) + y * Math.cos(rotation), 3, 0, Math.PI * 2); ctx.fillStyle = ink; ctx.fill();
      }
      ctx.globalAlpha = .85; ctx.lineWidth = 1.2; ctx.strokeStyle = ink;
      ctx.beginPath();
      for (let i = 0; i <= 400; i++) {
        const x = cx - r * 1.7 + i / 400 * r * 3.4;
        const envelope = Math.exp(-Math.pow((i - 200) / 85, 2));
        const y = cy + Math.sin(i * .85 + time * 7) * envelope * (2 + smooth * r * .45);
        if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = .35; ctx.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        ctx.beginPath(); ctx.ellipse(cx, h * .87, r * (1.12 + i * .13), r * (.1 + i * .035), 0, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvasRef} className="quantum-wave" aria-label={listening ? "Mikrofon sesine tepki veren akışkan dalga" : "Bekleyen akışkan dalga"} role="img" />;
}
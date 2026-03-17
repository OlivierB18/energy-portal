"use client";

import { useEffect, useRef } from "react";

interface Reading {
  timestamp: string;
  consumption: number;
  solar: number;
  grid: number;
}

interface EnergyChartProps {
  readings: Reading[];
}

export function EnergyChart({ readings }: EnergyChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || readings.length === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Aggregate readings to daily totals
    const daily: Record<string, { consumption: number; solar: number; grid: number }> = {};
    readings.forEach((r) => {
      const day = r.timestamp.slice(0, 10);
      if (!daily[day]) daily[day] = { consumption: 0, solar: 0, grid: 0 };
      daily[day].consumption += r.consumption;
      daily[day].solar += r.solar;
      daily[day].grid += r.grid;
    });

    const labels = Object.keys(daily).sort();
    const consumptionData = labels.map((l) => daily[l].consumption);
    const solarData = labels.map((l) => daily[l].solar);

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const paddingLeft = 55;
    const paddingRight = 20;
    const paddingTop = 20;
    const paddingBottom = 45;
    const chartWidth = width - paddingLeft - paddingRight;
    const chartHeight = height - paddingTop - paddingBottom;

    const maxVal = Math.max(...consumptionData, 1);

    // Background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    // Grid lines
    ctx.strokeStyle = "#f3f4f6";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = paddingTop + (chartHeight / 4) * i;
      ctx.beginPath();
      ctx.moveTo(paddingLeft, y);
      ctx.lineTo(paddingLeft + chartWidth, y);
      ctx.stroke();

      // Y-axis labels
      ctx.fillStyle = "#9ca3af";
      ctx.font = "11px system-ui";
      ctx.textAlign = "right";
      const val = Math.round((maxVal * (4 - i)) / 4);
      ctx.fillText(`${val}`, paddingLeft - 8, y + 4);
    }

    const barWidth = Math.max(4, (chartWidth / labels.length) * 0.7);
    const gap = chartWidth / labels.length;

    // Draw bars
    labels.forEach((label, i) => {
      const x = paddingLeft + i * gap + gap / 2;

      // Consumption bar
      const consHeight = (consumptionData[i] / maxVal) * chartHeight;
      ctx.fillStyle = "#3b82f6";
      ctx.globalAlpha = 0.7;
      ctx.fillRect(
        x - barWidth / 2 - 2,
        paddingTop + chartHeight - consHeight,
        barWidth / 2,
        consHeight
      );

      // Solar bar
      const solHeight = (solarData[i] / maxVal) * chartHeight;
      ctx.fillStyle = "#22c55e";
      ctx.fillRect(
        x + 2,
        paddingTop + chartHeight - solHeight,
        barWidth / 2,
        solHeight
      );
      ctx.globalAlpha = 1;

      // X-axis labels
      if (labels.length <= 14) {
        ctx.fillStyle = "#9ca3af";
        ctx.font = "10px system-ui";
        ctx.textAlign = "center";
        const date = new Date(label);
        const formatted = `${date.getDate()}/${date.getMonth() + 1}`;
        ctx.fillText(formatted, x, paddingTop + chartHeight + 16);
      }
    });

    // Legend
    const legendY = height - 10;
    ctx.fillStyle = "#3b82f6";
    ctx.globalAlpha = 0.7;
    ctx.fillRect(paddingLeft, legendY - 8, 12, 8);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#6b7280";
    ctx.font = "11px system-ui";
    ctx.textAlign = "left";
    ctx.fillText("Verbruik (kWh)", paddingLeft + 16, legendY);

    ctx.fillStyle = "#22c55e";
    ctx.fillRect(paddingLeft + 120, legendY - 8, 12, 8);
    ctx.fillStyle = "#6b7280";
    ctx.fillText("Zonne-energie (kWh)", paddingLeft + 136, legendY);
  }, [readings]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ display: "block" }}
    />
  );
}

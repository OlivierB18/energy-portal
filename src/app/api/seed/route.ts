import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

// POST /api/seed — creates demo data (only in non-production)
export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Not available in production" },
      { status: 403 }
    );
  }

  // Create two demo users with a password strong enough for local dev
  // Change or remove these accounts before deploying to a shared environment
  const password = await bcrypt.hash("D3m0#Br0uw3r!2024", 12);

  const user1 = await prisma.user.upsert({
    where: { email: "demo@brouwer-ems.nl" },
    update: {},
    create: {
      name: "Demo Gebruiker",
      email: "demo@brouwer-ems.nl",
      password,
      role: "user",
    },
  });

  const user2 = await prisma.user.upsert({
    where: { email: "admin@brouwer-ems.nl" },
    update: {},
    create: {
      name: "Admin",
      email: "admin@brouwer-ems.nl",
      password,
      role: "admin",
    },
  });

  // Create a site for user1
  const site = await prisma.site.upsert({
    where: { id: "demo-site-1" },
    update: {},
    create: {
      id: "demo-site-1",
      name: "Hoofdlocatie",
      address: "Energiestraat 1, Amsterdam",
      userId: user1.id,
    },
  });

  // Generate 14 days of hourly demo readings for user1
  const now = new Date();
  const readings = [];
  for (let d = 13; d >= 0; d--) {
    for (let h = 0; h < 24; h++) {
      const ts = new Date(now);
      ts.setDate(ts.getDate() - d);
      ts.setHours(h, 0, 0, 0);

      const solarFactor = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));
      const solar = parseFloat((solarFactor * 3.5 * (0.8 + Math.random() * 0.4)).toFixed(2));
      const consumption = parseFloat((0.5 + Math.random() * 2.5).toFixed(2));
      const grid = parseFloat(Math.max(0, consumption - solar).toFixed(2));

      readings.push({
        timestamp: ts,
        consumption,
        solar,
        grid,
        userId: user1.id,
        siteId: site.id,
      });
    }
  }

  await prisma.energyReading.deleteMany({ where: { userId: user1.id } });
  await prisma.energyReading.createMany({ data: readings });

  return NextResponse.json({
    message: "Demo data aangemaakt",
    users: [
      { email: user1.email, name: user1.name },
      { email: user2.email, name: user2.name },
    ],
    readingsCreated: readings.length,
  });
}

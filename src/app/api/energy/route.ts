import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const siteId = searchParams.get("siteId");
  const days = parseInt(searchParams.get("days") ?? "7", 10);

  const since = new Date();
  since.setDate(since.getDate() - days);

  const where: { userId: string; timestamp: { gte: Date }; siteId?: string } = {
    userId: session.user.id,
    timestamp: { gte: since },
  };

  if (siteId) {
    where.siteId = siteId;
  }

  const readings = await prisma.energyReading.findMany({
    where,
    orderBy: { timestamp: "asc" },
    take: 500,
  });

  const sites = await prisma.site.findMany({
    where: { userId: session.user.id },
    select: { id: true, name: true, address: true },
  });

  const totalConsumption = readings.reduce((s, r) => s + r.consumption, 0);
  const totalSolar = readings.reduce((s, r) => s + r.solar, 0);
  const totalGrid = readings.reduce((s, r) => s + r.grid, 0);

  return NextResponse.json({
    readings,
    sites,
    summary: {
      totalConsumption: Math.round(totalConsumption * 10) / 10,
      totalSolar: Math.round(totalSolar * 10) / 10,
      totalGrid: Math.round(totalGrid * 10) / 10,
      selfSufficiency:
        totalConsumption > 0
          ? Math.round((totalSolar / totalConsumption) * 1000) / 10
          : 0,
    },
  });
}

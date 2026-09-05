import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient;
}

let prisma: PrismaClient;

try {
  prisma = global.prisma || new PrismaClient();
  if (process.env.NODE_ENV !== "production") {
    global.prisma = prisma;
  }
} catch {
  console.warn("[AI Studio] Database not connected — using mock");
  const noOp = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async (d: unknown) => (d as { data?: unknown })?.data ?? {},
    update: async (d: unknown) => (d as { data?: unknown })?.data ?? {},
    delete: async () => ({}),
  };
  prisma = new Proxy({}, { get: () => noOp }) as unknown as PrismaClient;
}

export default prisma;

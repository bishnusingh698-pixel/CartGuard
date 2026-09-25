import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

// Reuse one client across dev hot reloads. Connection errors are NOT
// swallowed: if the database is unreachable the app must fail loudly.
if (process.env.NODE_ENV !== "production" && !global.prismaGlobal) {
  global.prismaGlobal = new PrismaClient();
}

const prisma: PrismaClient = global.prismaGlobal ?? new PrismaClient();

export default prisma;

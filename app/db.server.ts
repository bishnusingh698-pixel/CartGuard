import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: any | undefined;
}

function createPrismaMock() {
  console.warn("[AI Studio] Database not connected — using in-memory mock");
  const inMemorySessions = new Map<string, any>();
  const sessionMock = {
    count: async () => inMemorySessions.size,
    findUnique: async ({ where }: any) => inMemorySessions.get(where?.id) ?? null,
    findFirst: async ({ where }: any) => {
      for (const s of inMemorySessions.values()) {
        if (!where || !where.shop || s.shop === where.shop) return s;
      }
      return null;
    },
    findMany: async ({ where }: any = {}) => {
      let list = Array.from(inMemorySessions.values());
      if (where?.shop) {
        list = list.filter((s) => s.shop === where.shop);
      }
      return list;
    },
    create: async ({ data }: any) => {
      inMemorySessions.set(data.id, data);
      return data;
    },
    upsert: async ({ where, update, create }: any) => {
      const existing = inMemorySessions.get(where.id);
      const data = existing ? { ...existing, ...update } : create;
      inMemorySessions.set(where.id, data);
      return data;
    },
    update: async ({ where, data }: any) => {
      const existing = inMemorySessions.get(where.id) || {};
      const updated = { ...existing, ...data };
      inMemorySessions.set(where.id, updated);
      return updated;
    },
    updateMany: async () => ({ count: 1 }),
    delete: async ({ where }: any) => {
      inMemorySessions.delete(where?.id);
      return {};
    },
    deleteMany: async ({ where }: any = {}) => {
      let count = 0;
      if (where?.id?.in && Array.isArray(where.id.in)) {
        for (const id of where.id.in) {
          if (inMemorySessions.delete(id)) count++;
        }
      } else if (where?.shop) {
        for (const [id, s] of inMemorySessions.entries()) {
          if (s.shop === where.shop) {
            inMemorySessions.delete(id);
            count++;
          }
        }
      } else {
        count = inMemorySessions.size;
        inMemorySessions.clear();
      }
      return { count };
    },
  };

  const noOp = {
    count: async () => 0,
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async (d: any) => d?.data ?? {},
    update: async (d: any) => d?.data ?? {},
    delete: async () => ({}),
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
  };

  return new Proxy(
    { session: sessionMock },
    {
      get: (target: any, prop: string) => {
        if (prop in target) return target[prop];
        return noOp;
      },
    },
  );
}

let prisma: any;
if (process.env.DATABASE_URL) {
  try {
    if (process.env.NODE_ENV !== "production" && !global.prismaGlobal) {
      global.prismaGlobal = new PrismaClient();
    }
    prisma = global.prismaGlobal ?? new PrismaClient();
  } catch {
    prisma = createPrismaMock();
  }
} else {
  prisma = createPrismaMock();
}

export default prisma;


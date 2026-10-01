-- CreateTable
CREATE TABLE "ShopPreference" (
    "shop" TEXT NOT NULL,
    "language" TEXT,
    "languageChosenAt" TIMESTAMP(3),

    CONSTRAINT "ShopPreference_pkey" PRIMARY KEY ("shop")
);

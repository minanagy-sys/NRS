-- CreateTable
CREATE TABLE "ApiQuery" (
    "id" SERIAL NOT NULL,
    "api" TEXT NOT NULL DEFAULT 'supermetrics',
    "dsId" TEXT,
    "label" TEXT,
    "rows" INTEGER NOT NULL DEFAULT 0,
    "ms" INTEGER,
    "month" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiQuery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiQuery_api_month_idx" ON "ApiQuery"("api", "month");

-- CreateIndex
CREATE INDEX "ApiQuery_at_idx" ON "ApiQuery"("at");

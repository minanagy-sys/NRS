-- CreateTable
CREATE TABLE "CollectionDay" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "gross" DECIMAL(14,2) NOT NULL,
    "refunds" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(14,2) NOT NULL,
    "packageShare" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "txns" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,

    CONSTRAINT "CollectionDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CollectionDay_source_date_key" ON "CollectionDay"("source", "date");

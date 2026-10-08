-- Package money per branch per day. See the PackageDay model.

-- CreateTable
CREATE TABLE "PackageDay" (
    "date" DATE NOT NULL,
    "branchName" TEXT NOT NULL,
    "saleTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "saleResidual" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "settled" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sales" INTEGER NOT NULL DEFAULT 0,
    "settlements" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'odoo',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackageDay_pkey" PRIMARY KEY ("date","branchName","source")
);

-- CreateIndex
CREATE INDEX "PackageDay_date_idx" ON "PackageDay"("date");


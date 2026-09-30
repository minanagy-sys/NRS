-- CreateTable
CREATE TABLE "Consumable" (
    "id" SERIAL NOT NULL,
    "odooId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "vendorName" TEXT,
    "category" TEXT,
    "unit" TEXT,
    "dosesPerUnit" DECIMAL(10,3),
    "mergeIntoOdooId" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Consumable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumableLink" (
    "id" SERIAL NOT NULL,
    "serviceProductId" INTEGER,
    "serviceName" TEXT NOT NULL,
    "consumableOdooId" INTEGER,
    "dosesPerService" DECIMAL(10,3),
    "source" TEXT NOT NULL DEFAULT 'seed',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsumableLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorTerm" (
    "id" SERIAL NOT NULL,
    "year" INTEGER NOT NULL,
    "supplierName" TEXT NOT NULL,
    "cashbackRate" DECIMAL(6,4),
    "basisNote" TEXT,
    "targetLabel" TEXT,
    "targetAmount" DECIMAL(14,2),
    "source" TEXT NOT NULL DEFAULT 'seed',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseReturn" (
    "id" SERIAL NOT NULL,
    "date" DATE,
    "supplierName" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "category" TEXT,
    "qty" DECIMAL(14,3) NOT NULL,
    "unitCost" DECIMAL(14,4),
    "value" DECIMAL(14,2) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Consumable_odooId_key" ON "Consumable"("odooId");

-- CreateIndex
CREATE INDEX "Consumable_category_idx" ON "Consumable"("category");

-- CreateIndex
CREATE INDEX "Consumable_mergeIntoOdooId_idx" ON "Consumable"("mergeIntoOdooId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsumableLink_serviceName_key" ON "ConsumableLink"("serviceName");

-- CreateIndex
CREATE INDEX "ConsumableLink_consumableOdooId_idx" ON "ConsumableLink"("consumableOdooId");

-- CreateIndex
CREATE INDEX "ConsumableLink_serviceProductId_idx" ON "ConsumableLink"("serviceProductId");

-- CreateIndex
CREATE INDEX "VendorTerm_year_idx" ON "VendorTerm"("year");

-- CreateIndex
CREATE UNIQUE INDEX "VendorTerm_year_supplierName_key" ON "VendorTerm"("year", "supplierName");

-- CreateIndex
CREATE INDEX "PurchaseReturn_supplierName_idx" ON "PurchaseReturn"("supplierName");

-- CreateIndex
CREATE INDEX "PurchaseReturn_date_idx" ON "PurchaseReturn"("date");

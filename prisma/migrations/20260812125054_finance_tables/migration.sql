-- CreateTable
CREATE TABLE "FinanceSource" (
    "section" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'snapshot',
    "cutover" DATE,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceSource_pkey" PRIMARY KEY ("section")
);

-- CreateTable
CREATE TABLE "FinanceBatch" (
    "id" SERIAL NOT NULL,
    "section" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT,

    CONSTRAINT "FinanceBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Collection" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "branch" TEXT NOT NULL,
    "register" TEXT NOT NULL,
    "gross" DECIMAL(14,2) NOT NULL,
    "refunds" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(14,2) NOT NULL,
    "packageShare" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "txns" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Register" (
    "name" TEXT NOT NULL,
    "availability" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Register_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "name" TEXT NOT NULL,
    "category" TEXT,
    "opening" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "closing" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "Bill" (
    "id" SERIAL NOT NULL,
    "ref" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "gross" DECIMAL(14,2) NOT NULL,
    "net" DECIMAL(14,2) NOT NULL,
    "vat" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "branch" TEXT,
    "srcSystem" TEXT,
    "source" TEXT NOT NULL,

    CONSTRAINT "Bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillLine" (
    "id" SERIAL NOT NULL,
    "billId" INTEGER NOT NULL,
    "product" TEXT NOT NULL,
    "category" TEXT,
    "qty" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "isBonus" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BillLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorPayment" (
    "id" SERIAL NOT NULL,
    "supplierName" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "journal" TEXT NOT NULL,
    "ref" TEXT,
    "method" TEXT,
    "source" TEXT NOT NULL,

    CONSTRAINT "VendorPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalMethod" (
    "journal" TEXT NOT NULL,
    "method" TEXT NOT NULL,

    CONSTRAINT "JournalMethod_pkey" PRIMARY KEY ("journal")
);

-- CreateTable
CREATE TABLE "ReconProduct" (
    "id" SERIAL NOT NULL,
    "soldName" TEXT NOT NULL,
    "stockName" TEXT,
    "unitCost" DECIMAL(14,4) NOT NULL,
    "matched" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL,

    CONSTRAINT "ReconProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconFact" (
    "id" SERIAL NOT NULL,
    "reconProductId" INTEGER NOT NULL,
    "branch" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "value" DECIMAL(14,2),

    CONSTRAINT "ReconFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpiryLot" (
    "id" SERIAL NOT NULL,
    "location" TEXT NOT NULL,
    "isWarehouse" BOOLEAN NOT NULL DEFAULT false,
    "product" TEXT NOT NULL,
    "lot" TEXT NOT NULL,
    "expiry" DATE NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "unitCost" DECIMAL(14,2) NOT NULL,
    "rateMonthly" DECIMAL(14,4),
    "companyRate" DECIMAL(14,4),
    "netIssued" DECIMAL(14,3),
    "source" TEXT NOT NULL,

    CONSTRAINT "ExpiryLot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinanceBatch_section_source_idx" ON "FinanceBatch"("section", "source");

-- CreateIndex
CREATE INDEX "Collection_source_date_idx" ON "Collection"("source", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Collection_source_date_branch_register_key" ON "Collection"("source", "date", "branch", "register");

-- CreateIndex
CREATE INDEX "Bill_source_date_idx" ON "Bill"("source", "date");

-- CreateIndex
CREATE INDEX "Bill_supplierName_idx" ON "Bill"("supplierName");

-- CreateIndex
CREATE UNIQUE INDEX "Bill_source_ref_supplierName_key" ON "Bill"("source", "ref", "supplierName");

-- CreateIndex
CREATE INDEX "BillLine_billId_idx" ON "BillLine"("billId");

-- CreateIndex
CREATE INDEX "BillLine_product_idx" ON "BillLine"("product");

-- CreateIndex
CREATE INDEX "VendorPayment_source_date_idx" ON "VendorPayment"("source", "date");

-- CreateIndex
CREATE INDEX "VendorPayment_supplierName_idx" ON "VendorPayment"("supplierName");

-- CreateIndex
CREATE INDEX "ReconProduct_source_idx" ON "ReconProduct"("source");

-- CreateIndex
CREATE UNIQUE INDEX "ReconProduct_source_soldName_stockName_key" ON "ReconProduct"("source", "soldName", "stockName");

-- CreateIndex
CREATE INDEX "ReconFact_reconProductId_idx" ON "ReconFact"("reconProductId");

-- CreateIndex
CREATE INDEX "ReconFact_date_idx" ON "ReconFact"("date");

-- CreateIndex
CREATE UNIQUE INDEX "ReconFact_reconProductId_branch_date_kind_key" ON "ReconFact"("reconProductId", "branch", "date", "kind");

-- CreateIndex
CREATE INDEX "ExpiryLot_source_expiry_idx" ON "ExpiryLot"("source", "expiry");

-- CreateIndex
CREATE INDEX "ExpiryLot_product_idx" ON "ExpiryLot"("product");

-- CreateIndex
CREATE UNIQUE INDEX "ExpiryLot_source_location_product_lot_key" ON "ExpiryLot"("source", "location", "product", "lot");

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_supplierName_fkey" FOREIGN KEY ("supplierName") REFERENCES "Supplier"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillLine" ADD CONSTRAINT "BillLine_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPayment" ADD CONSTRAINT "VendorPayment_supplierName_fkey" FOREIGN KEY ("supplierName") REFERENCES "Supplier"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconFact" ADD CONSTRAINT "ReconFact_reconProductId_fkey" FOREIGN KEY ("reconProductId") REFERENCES "ReconProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

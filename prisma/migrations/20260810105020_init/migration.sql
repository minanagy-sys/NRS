-- CreateTable
CREATE TABLE "Invoice" (
    "odooId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "invoiceDate" DATE NOT NULL,
    "moveType" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "branchId" INTEGER,
    "branchName" TEXT,
    "specialistId" INTEGER,
    "specialistName" TEXT,
    "partnerId" INTEGER,
    "partnerName" TEXT,
    "amountUntaxed" DECIMAL(14,2) NOT NULL,
    "amountTotal" DECIMAL(14,2) NOT NULL,
    "isNewCustomer" BOOLEAN NOT NULL DEFAULT false,
    "pulledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("odooId")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "odooId" INTEGER NOT NULL,
    "invoiceOdooId" INTEGER NOT NULL,
    "productId" INTEGER,
    "productName" TEXT,
    "categoryId" INTEGER,
    "categoryName" TEXT,
    "quantity" DECIMAL(14,3) NOT NULL,
    "priceSubtotal" DECIMAL(14,2) NOT NULL,
    "priceTotal" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("odooId")
);

-- CreateTable
CREATE TABLE "StockQuant" (
    "id" SERIAL NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "productId" INTEGER NOT NULL,
    "productName" TEXT NOT NULL,
    "categoryName" TEXT,
    "uom" TEXT,
    "locationId" INTEGER NOT NULL,
    "locationName" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "reserved" DECIMAL(14,3) NOT NULL DEFAULT 0,

    CONSTRAINT "StockQuant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" SERIAL NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "trigger" TEXT NOT NULL,
    "actor" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "invoices" INTEGER NOT NULL DEFAULT 0,
    "lines" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DaySnapshot" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "pulledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoices" INTEGER NOT NULL,
    "amountUntaxed" DECIMAL(14,2) NOT NULL,
    "amountTotal" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "DaySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetPeriod" (
    "id" SERIAL NOT NULL,
    "period" TEXT NOT NULL,
    "daysInPeriod" INTEGER NOT NULL,
    "sourceLabel" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TargetPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetGroup" (
    "id" SERIAL NOT NULL,
    "periodId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "target" DECIMAL(14,2) NOT NULL,
    "rosterCount" INTEGER NOT NULL,
    "unlistedCount" INTEGER NOT NULL DEFAULT 0,
    "unlistedTarget" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "TargetGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctorTarget" (
    "id" SERIAL NOT NULL,
    "periodId" INTEGER NOT NULL,
    "scheduleName" TEXT NOT NULL,
    "groupName" TEXT,
    "monthlyTarget" DECIMAL(14,2) NOT NULL,
    "prevMonth" DECIMAL(14,2),
    "hasSales" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "DoctorTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchTarget" (
    "id" SERIAL NOT NULL,
    "periodId" INTEGER NOT NULL,
    "scheduleName" TEXT NOT NULL,
    "target1" DECIMAL(14,2) NOT NULL,
    "target2" DECIMAL(14,2),

    CONSTRAINT "BranchTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityAlias" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "scheduleName" TEXT NOT NULL,
    "odooName" TEXT NOT NULL,
    "odooId" INTEGER,

    CONSTRAINT "IdentityAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "displayName" TEXT,
    "tokenCipher" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthRequest" (
    "state" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redirect" TEXT,

    CONSTRAINT "AuthRequest_pkey" PRIMARY KEY ("state")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" SERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "ip" TEXT,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Invoice_invoiceDate_idx" ON "Invoice"("invoiceDate");

-- CreateIndex
CREATE INDEX "Invoice_invoiceDate_moveType_idx" ON "Invoice"("invoiceDate", "moveType");

-- CreateIndex
CREATE INDEX "Invoice_branchId_idx" ON "Invoice"("branchId");

-- CreateIndex
CREATE INDEX "Invoice_specialistId_idx" ON "Invoice"("specialistId");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceOdooId_idx" ON "InvoiceLine"("invoiceOdooId");

-- CreateIndex
CREATE INDEX "InvoiceLine_productId_idx" ON "InvoiceLine"("productId");

-- CreateIndex
CREATE INDEX "StockQuant_takenAt_idx" ON "StockQuant"("takenAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockQuant_takenAt_productId_locationId_key" ON "StockQuant"("takenAt", "productId", "locationId");

-- CreateIndex
CREATE INDEX "SyncRun_startedAt_idx" ON "SyncRun"("startedAt");

-- CreateIndex
CREATE INDEX "DaySnapshot_date_idx" ON "DaySnapshot"("date");

-- CreateIndex
CREATE UNIQUE INDEX "TargetPeriod_period_key" ON "TargetPeriod"("period");

-- CreateIndex
CREATE UNIQUE INDEX "TargetGroup_periodId_name_key" ON "TargetGroup"("periodId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "DoctorTarget_periodId_scheduleName_key" ON "DoctorTarget"("periodId", "scheduleName");

-- CreateIndex
CREATE UNIQUE INDEX "BranchTarget_periodId_scheduleName_key" ON "BranchTarget"("periodId", "scheduleName");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityAlias_kind_scheduleName_key" ON "IdentityAlias"("kind", "scheduleName");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditEvent_at_idx" ON "AuditEvent"("at");

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceOdooId_fkey" FOREIGN KEY ("invoiceOdooId") REFERENCES "Invoice"("odooId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetGroup" ADD CONSTRAINT "TargetGroup_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "TargetPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorTarget" ADD CONSTRAINT "DoctorTarget_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "TargetPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchTarget" ADD CONSTRAINT "BranchTarget_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "TargetPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

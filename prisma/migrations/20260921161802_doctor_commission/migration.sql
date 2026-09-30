-- CreateTable
CREATE TABLE "CommissionScheme" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "bands" JSONB NOT NULL,
    "hourlyRate" DECIMAL(10,2),
    "fixedBasic" DECIMAL(12,2),
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionScheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctorScheme" (
    "id" SERIAL NOT NULL,
    "doctorName" TEXT NOT NULL,
    "schemeId" INTEGER,
    "hourlyRate" DECIMAL(10,2),
    "mgmtFee" DECIMAL(12,2),
    "taxRate" DECIMAL(6,4),
    "payMethod" TEXT,
    "bankAcc" TEXT,
    "bankName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DoctorScheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctorPayrollMonth" (
    "id" SERIAL NOT NULL,
    "period" TEXT NOT NULL,
    "doctorName" TEXT NOT NULL,
    "hours" DECIMAL(10,2),
    "ded" DECIMAL(12,2),
    "dedReason" TEXT,
    "onda" DECIMAL(12,2),
    "mgmt" DECIMAL(12,2),
    "taxRate" DECIMAL(6,4),
    "maint" DECIMAL(12,2),
    "gcell" DECIMAL(12,2),
    "adjustment" DECIMAL(12,2),
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DoctorPayrollMonth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommissionScheme_name_key" ON "CommissionScheme"("name");

-- CreateIndex
CREATE UNIQUE INDEX "DoctorScheme_doctorName_key" ON "DoctorScheme"("doctorName");

-- CreateIndex
CREATE INDEX "DoctorScheme_schemeId_idx" ON "DoctorScheme"("schemeId");

-- CreateIndex
CREATE INDEX "DoctorPayrollMonth_period_idx" ON "DoctorPayrollMonth"("period");

-- CreateIndex
CREATE UNIQUE INDEX "DoctorPayrollMonth_period_doctorName_key" ON "DoctorPayrollMonth"("period", "doctorName");

-- AddForeignKey
ALTER TABLE "DoctorScheme" ADD CONSTRAINT "DoctorScheme_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "CommissionScheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;

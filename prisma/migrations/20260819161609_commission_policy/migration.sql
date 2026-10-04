-- CreateTable
CREATE TABLE "CommissionPolicy" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionPolicy_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "CommissionBranch" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "journalCode" TEXT,
    "annualTarget" DECIMAL(14,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionBranch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionDepartment" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "multiplier" DECIMAL(6,3),
    "mixFloor" DECIMAL(6,4),
    "mixCap" DECIMAL(6,4),
    "groupMix" DECIMAL(6,4),
    "condition" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CommissionDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionTarget" (
    "id" SERIAL NOT NULL,
    "branchId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "target" DECIMAL(14,2) NOT NULL,
    "floorPct" DECIMAL(6,4),
    "midPct" DECIMAL(6,4),
    "maxPct" DECIMAL(6,4),
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionSplit" (
    "id" SERIAL NOT NULL,
    "branchId" INTEGER NOT NULL,
    "departmentId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "annualTarget" DECIMAL(14,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionSplit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionTier" (
    "tierNo" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "revFrom" DECIMAL(14,2) NOT NULL,
    "revTo" DECIMAL(14,2),
    "recepMin" DECIMAL(12,2) NOT NULL,
    "recepMax" DECIMAL(12,2) NOT NULL,
    "seniorMin" DECIMAL(12,2) NOT NULL,
    "seniorMax" DECIMAL(12,2) NOT NULL,
    "girlMin" DECIMAL(12,2) NOT NULL,
    "girlMax" DECIMAL(12,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionTier_pkey" PRIMARY KEY ("tierNo")
);

-- CreateTable
CREATE TABLE "CommissionRole" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "sharePct" DECIMAL(6,4) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallCenterRate" (
    "id" SERIAL NOT NULL,
    "bucket" TEXT NOT NULL,
    "windowLabel" TEXT,
    "bonus" DECIMAL(10,2) NOT NULL,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallCenterRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallCenterMember" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "serves" TEXT,
    "scheme" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallCenterMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShowRateBand" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "threshold" DECIMAL(6,4) NOT NULL,
    "bonus" DECIMAL(12,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowRateBand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagementGate" (
    "id" SERIAL NOT NULL,
    "role" TEXT NOT NULL,
    "headcount" INTEGER NOT NULL,
    "rate" DECIMAL(6,4) NOT NULL,
    "base" TEXT NOT NULL,
    "minBranches" INTEGER,
    "groupPct" DECIMAL(6,4),
    "scope" TEXT,
    "gateLabel" TEXT,
    "gateLogic" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagementGate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionRule" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "treatment" TEXT NOT NULL,
    "affects" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CommissionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionNote" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "severity" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "expected" TEXT,
    "resolution" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommissionBranch_name_key" ON "CommissionBranch"("name");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionDepartment_key_key" ON "CommissionDepartment"("key");

-- CreateIndex
CREATE INDEX "CommissionTarget_year_month_idx" ON "CommissionTarget"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionTarget_branchId_year_month_key" ON "CommissionTarget"("branchId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionSplit_branchId_departmentId_year_key" ON "CommissionSplit"("branchId", "departmentId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionRole_name_key" ON "CommissionRole"("name");

-- CreateIndex
CREATE UNIQUE INDEX "CallCenterRate_bucket_key" ON "CallCenterRate"("bucket");

-- CreateIndex
CREATE UNIQUE INDEX "CallCenterMember_name_key" ON "CallCenterMember"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ShowRateBand_threshold_key" ON "ShowRateBand"("threshold");

-- CreateIndex
CREATE UNIQUE INDEX "ManagementGate_role_key" ON "ManagementGate"("role");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionNote_kind_ref_key" ON "CommissionNote"("kind", "ref");

-- AddForeignKey
ALTER TABLE "CommissionTarget" ADD CONSTRAINT "CommissionTarget_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "CommissionBranch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionSplit" ADD CONSTRAINT "CommissionSplit_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "CommissionBranch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionSplit" ADD CONSTRAINT "CommissionSplit_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "CommissionDepartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

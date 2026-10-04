-- CreateTable
CREATE TABLE "CommissionLevel" (
    "version" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "fromPct" DECIMAL(6,4) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionLevel_pkey" PRIMARY KEY ("version","level")
);

-- CreateTable
CREATE TABLE "CommissionPool" (
    "version" TEXT NOT NULL,
    "tierNo" INTEGER NOT NULL,
    "revFrom" DECIMAL(14,2) NOT NULL,
    "revTo" DECIMAL(14,2),
    "pools" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionPool_pkey" PRIMARY KEY ("version","tierNo")
);

-- CreateTable
CREATE TABLE "CommissionRoleWeight" (
    "version" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "people" INTEGER NOT NULL,
    "weight" DECIMAL(6,2) NOT NULL,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionRoleWeight_pkey" PRIMARY KEY ("version","role")
);

-- CreateTable
CREATE TABLE "CommissionStaff" (
    "id" SERIAL NOT NULL,
    "branchId" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payMethod" TEXT,
    "bankAcc" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionStaff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctorPlanMonth" (
    "doctorName" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "groupName" TEXT,
    "target" DECIMAL(14,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DoctorPlanMonth_pkey" PRIMARY KEY ("doctorName","period")
);

-- CreateTable
CREATE TABLE "HistoryMonth" (
    "period" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ex" DECIMAL(14,2) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'seed',

    CONSTRAINT "HistoryMonth_pkey" PRIMARY KEY ("period","kind","name")
);

-- CreateIndex
CREATE INDEX "CommissionStaff_branchId_idx" ON "CommissionStaff"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionStaff_branchId_role_name_key" ON "CommissionStaff"("branchId", "role", "name");

-- CreateIndex
CREATE INDEX "DoctorPlanMonth_period_idx" ON "DoctorPlanMonth"("period");

-- CreateIndex
CREATE INDEX "HistoryMonth_period_idx" ON "HistoryMonth"("period");

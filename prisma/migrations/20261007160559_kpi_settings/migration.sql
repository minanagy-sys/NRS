-- Editable settings for the Performance KPIs report. See KpiThreshold/KpiLevel.
--
-- The `prisma migrate diff` that produced the CREATEs below also emitted
-- `DROP TABLE "DoctorShift"`, which is pre-existing drift between the schema
-- and this database and nothing to do with this change. It is omitted here:
-- running it would have destroyed that table's rows.

-- CreateTable
CREATE TABLE "KpiThreshold" (
    "id" TEXT NOT NULL,
    "base" DECIMAL(14,6),
    "t100" DECIMAL(14,6),
    "why" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KpiThreshold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KpiLevel" (
    "idx" INTEGER NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "nameAr" TEXT NOT NULL DEFAULT '',
    "scope" TEXT NOT NULL DEFAULT '',
    "fromLabel" TEXT NOT NULL DEFAULT '',
    "toLabel" TEXT NOT NULL DEFAULT '',
    "value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "kpiRef" TEXT NOT NULL DEFAULT '',
    "detail" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KpiLevel_pkey" PRIMARY KEY ("idx")
);


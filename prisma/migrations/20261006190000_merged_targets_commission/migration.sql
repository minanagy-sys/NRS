-- CreateTable
CREATE TABLE "HistoryDay" (
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "ex" DECIMAL(14,2) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'artifact',

    CONSTRAINT "HistoryDay_pkey" PRIMARY KEY ("date","name")
);

-- CreateTable
CREATE TABLE "HistoryDayDoctor" (
    "date" DATE NOT NULL,
    "doctorName" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "ex" DECIMAL(14,2) NOT NULL,
    "invoices" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'artifact',

    CONSTRAINT "HistoryDayDoctor_pkey" PRIMARY KEY ("date","doctorName","branchName","productType")
);

-- CreateTable
CREATE TABLE "PlanSeasonality" (
    "branchName" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "groupName" TEXT NOT NULL,
    "ex" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "PlanSeasonality_pkey" PRIMARY KEY ("branchName","month","groupName")
);

-- CreateTable
CREATE TABLE "PlanProductMix" (
    "branchName" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "share" DECIMAL(8,6) NOT NULL,

    CONSTRAINT "PlanProductMix_pkey" PRIMARY KEY ("branchName","groupName","productType")
);

-- CreateTable
CREATE TABLE "WeekdayWeight" (
    "dow" INTEGER NOT NULL,
    "weight" DECIMAL(8,4) NOT NULL,

    CONSTRAINT "WeekdayWeight_pkey" PRIMARY KEY ("dow")
);

-- CreateTable
CREATE TABLE "DoctorProfile" (
    "name" TEXT NOT NULL,
    "groupName" TEXT,
    "department" TEXT,
    "branches" TEXT[],
    "mix" JSONB,
    "source" TEXT NOT NULL DEFAULT 'artifact',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DoctorProfile_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "DoctorRosterSlot" (
    "id" SERIAL NOT NULL,
    "doctorName" TEXT NOT NULL,
    "dow" INTEGER NOT NULL,
    "branchName" TEXT NOT NULL,
    "hours" DECIMAL(5,2) NOT NULL,
    "startTime" TEXT NOT NULL DEFAULT '',
    "endTime" TEXT NOT NULL DEFAULT '',
    "department" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'artifact',

    CONSTRAINT "DoctorRosterSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HistoryDay_date_idx" ON "HistoryDay"("date");

-- CreateIndex
CREATE INDEX "HistoryDayDoctor_date_idx" ON "HistoryDayDoctor"("date");

-- CreateIndex
CREATE INDEX "HistoryDayDoctor_doctorName_idx" ON "HistoryDayDoctor"("doctorName");

-- CreateIndex
CREATE INDEX "PlanSeasonality_branchName_idx" ON "PlanSeasonality"("branchName");

-- CreateIndex
CREATE INDEX "PlanProductMix_branchName_idx" ON "PlanProductMix"("branchName");

-- CreateIndex
CREATE INDEX "DoctorRosterSlot_doctorName_idx" ON "DoctorRosterSlot"("doctorName");

-- CreateIndex
CREATE INDEX "DoctorRosterSlot_dow_idx" ON "DoctorRosterSlot"("dow");

-- CreateIndex
CREATE INDEX "DoctorRosterSlot_branchName_idx" ON "DoctorRosterSlot"("branchName");

-- AddForeignKey
ALTER TABLE "DoctorRosterSlot" ADD CONSTRAINT "DoctorRosterSlot_doctorName_fkey" FOREIGN KEY ("doctorName") REFERENCES "DoctorProfile"("name") ON DELETE CASCADE ON UPDATE CASCADE;


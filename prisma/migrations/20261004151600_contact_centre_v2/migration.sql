-- CreateTable
CREATE TABLE "CcLookup" (
    "kind" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'seed',

    CONSTRAINT "CcLookup_pkey" PRIMARY KEY ("kind","idx","source")
);

-- CreateTable
CREATE TABLE "CcOpportunity" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "hour" INTEGER NOT NULL,
    "personIdx" INTEGER NOT NULL,
    "branchIdx" INTEGER NOT NULL,
    "deptIdx" INTEGER NOT NULL,
    "doctorIdx" INTEGER NOT NULL,
    "outcome" INTEGER NOT NULL,
    "showed" BOOLEAN NOT NULL DEFAULT false,
    "ownBooking" BOOLEAN NOT NULL DEFAULT false,
    "revenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "team" INTEGER NOT NULL DEFAULT 1,
    "loginIdx" INTEGER NOT NULL,
    "phoneHash" TEXT,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CcOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CcAppointment" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "slotMinutes" INTEGER NOT NULL,
    "branchIdx" INTEGER NOT NULL,
    "doctorIdx" INTEGER NOT NULL,
    "stateCode" INTEGER NOT NULL,
    "sourceCode" INTEGER NOT NULL,
    "bookerIdx" INTEGER NOT NULL,
    "familyIdx" INTEGER NOT NULL,
    "categoryIdx" INTEGER NOT NULL,
    "serviceLines" INTEGER NOT NULL DEFAULT 0,
    "hadConfirmCall" BOOLEAN NOT NULL DEFAULT false,
    "confirmByIdx" INTEGER NOT NULL DEFAULT -1,
    "isReschedule" BOOLEAN NOT NULL DEFAULT false,
    "isZat" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CcAppointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CcLead" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "hour" INTEGER NOT NULL,
    "loginIdx" INTEGER NOT NULL,
    "branchIdx" INTEGER NOT NULL,
    "booked" BOOLEAN NOT NULL DEFAULT false,
    "minutesToBooking" INTEGER NOT NULL DEFAULT -1,
    "duplicateOfCc" BOOLEAN NOT NULL DEFAULT false,
    "openerIdx" INTEGER NOT NULL,
    "employeeOverwritten" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CcLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CcActivity" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "hour" INTEGER NOT NULL,
    "typeIdx" INTEGER NOT NULL,
    "loginIdx" INTEGER NOT NULL,
    "state" INTEGER NOT NULL,
    "outcomeIdx" INTEGER NOT NULL DEFAULT -1,
    "branchIdx" INTEGER NOT NULL,
    "onCcOpp" BOOLEAN NOT NULL DEFAULT false,
    "personIdx" INTEGER NOT NULL DEFAULT -1,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CcActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CcRebooking" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "leadBranchIdx" INTEGER NOT NULL,
    "rebookLoginIdx" INTEGER NOT NULL DEFAULT -1,
    "rebookBranchIdx" INTEGER NOT NULL,
    "credited" BOOLEAN NOT NULL DEFAULT false,
    "agentIdx" INTEGER NOT NULL,
    "team" INTEGER NOT NULL DEFAULT 1,
    "personIdx" INTEGER NOT NULL DEFAULT -1,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CcRebooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CcEmployee" (
    "name" TEXT NOT NULL,
    "department" TEXT NOT NULL DEFAULT '',
    "jobTitle" TEXT NOT NULL DEFAULT '',
    "homeLogin" TEXT NOT NULL DEFAULT '',
    "allowedIds" INTEGER[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CcEmployee_pkey" PRIMARY KEY ("name","source")
);

-- CreateTable
CREATE TABLE "PbxExtension" (
    "ext" TEXT NOT NULL,
    "phoneName" TEXT NOT NULL DEFAULT '',
    "odooEmployee" TEXT NOT NULL DEFAULT '',
    "team" TEXT NOT NULL DEFAULT 'other',
    "branch" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'seed',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PbxExtension_pkey" PRIMARY KEY ("ext")
);

-- CreateIndex
CREATE INDEX "CcLookup_kind_idx" ON "CcLookup"("kind");

-- CreateIndex
CREATE INDEX "CcOpportunity_date_idx" ON "CcOpportunity"("date");

-- CreateIndex
CREATE INDEX "CcOpportunity_phoneHash_idx" ON "CcOpportunity"("phoneHash");

-- CreateIndex
CREATE INDEX "CcOpportunity_personIdx_idx" ON "CcOpportunity"("personIdx");

-- CreateIndex
CREATE INDEX "CcAppointment_date_idx" ON "CcAppointment"("date");

-- CreateIndex
CREATE INDEX "CcAppointment_branchIdx_idx" ON "CcAppointment"("branchIdx");

-- CreateIndex
CREATE INDEX "CcLead_date_idx" ON "CcLead"("date");

-- CreateIndex
CREATE INDEX "CcLead_loginIdx_idx" ON "CcLead"("loginIdx");

-- CreateIndex
CREATE INDEX "CcActivity_date_idx" ON "CcActivity"("date");

-- CreateIndex
CREATE INDEX "CcRebooking_date_idx" ON "CcRebooking"("date");

-- CreateIndex
CREATE INDEX "CcEmployee_department_idx" ON "CcEmployee"("department");

-- CreateIndex
CREATE INDEX "PbxExtension_team_idx" ON "PbxExtension"("team");

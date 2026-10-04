-- CreateTable
CREATE TABLE "Appointment" (
    "odooId" INTEGER NOT NULL,
    "name" TEXT,
    "date" DATE NOT NULL,
    "states" TEXT NOT NULL,
    "cancelReason" TEXT,
    "branchId" INTEGER,
    "branchName" TEXT,
    "specialistId" INTEGER,
    "specialistName" TEXT,
    "partnerId" INTEGER,
    "partnerName" TEXT,
    "createUid" INTEGER,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3),
    "mobileKey" TEXT,
    "invoiceTotal" DECIMAL(14,2),
    "dueAmount" DECIMAL(14,2),
    "isRescheduled" BOOLEAN NOT NULL DEFAULT false,
    "pulledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("odooId")
);

-- CreateIndex
CREATE INDEX "Appointment_date_idx" ON "Appointment"("date");

-- CreateIndex
CREATE INDEX "Appointment_date_states_idx" ON "Appointment"("date", "states");

-- CreateIndex
CREATE INDEX "Appointment_branchName_idx" ON "Appointment"("branchName");

-- CreateIndex
CREATE INDEX "Appointment_specialistName_idx" ON "Appointment"("specialistName");

-- CreateIndex
CREATE INDEX "Appointment_mobileKey_idx" ON "Appointment"("mobileKey");

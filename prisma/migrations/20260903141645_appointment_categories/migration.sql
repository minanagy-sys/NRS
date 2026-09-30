-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "categories" TEXT[],
ADD COLUMN     "hasLaser" BOOLEAN NOT NULL DEFAULT false;

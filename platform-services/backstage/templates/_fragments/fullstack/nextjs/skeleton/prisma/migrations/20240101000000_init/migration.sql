-- Initial migration for the sample `Note` model in prisma/schema.prisma.
-- Shipped so the starter is runnable end-to-end: the chart's migration initContainer
-- runs `prisma migrate deploy` on every deploy, creating this table automatically once
-- DATABASE_URL is set. Regenerate/extend it locally with `prisma migrate dev --name <x>`
-- after you change the schema, then commit the new migration folder.

-- CreateTable
CREATE TABLE `Note` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(200) NOT NULL,
    `body` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

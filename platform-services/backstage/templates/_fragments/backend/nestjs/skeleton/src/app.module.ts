import { Module } from '@nestjs/common'
import { DbService } from './db.service'
import { HealthController } from './health.controller'
import { ItemsController } from './items/items.controller'
import { ItemsService } from './items/items.service'

// Root module. DbService is provided once (a lazy mysql2 pool from DATABASE_URL) and
// injected into the feature services. Add your own feature modules/controllers here.
@Module({
  controllers: [HealthController, ItemsController],
  providers: [DbService, ItemsService],
})
export class AppModule {}

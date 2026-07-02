import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  BadRequestException,
} from '@nestjs/common'
import { ItemsService, Item } from './items.service'

// Sample CRUD controller. With the global "/api" prefix (main.ts) these routes are served
// under /api/items, so the ingress "/api" route reaches them in a frontend+backend app.
// /api/health lives here too (DB-aware), distinct from the DB-independent root /healthz.
@Controller()
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get('health')
  health() {
    return this.items.apiHealth()
  }

  @Get('items')
  async list(): Promise<{ items: Item[] }> {
    return { items: await this.items.list() }
  }

  @Get('items/:id')
  get(@Param('id', ParseIntPipe) id: number): Promise<Item> {
    return this.items.get(id)
  }

  @Post('items')
  @HttpCode(201)
  create(@Body() body: { name?: unknown }): Promise<Item> {
    return this.items.create(this.requireName(body))
  }

  @Put('items/:id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name?: unknown },
  ): Promise<Item> {
    return this.items.update(id, this.requireName(body))
  }

  @Delete('items/:id')
  @HttpCode(204)
  remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.items.remove(id)
  }

  private requireName(body: { name?: unknown }): string {
    const name = String(body?.name ?? '').trim()
    if (!name) throw new BadRequestException('name is required')
    return name
  }
}

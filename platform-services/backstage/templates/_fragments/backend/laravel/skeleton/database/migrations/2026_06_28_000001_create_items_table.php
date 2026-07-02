<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Migration for the sample Item model. Apply with `php artisan migrate` at deploy time
// (see MIGRATIONS.md), NOT from the app process. String columns are length-bounded
// because MySQL requires an explicit length on VARCHAR.
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('items', function (Blueprint $table) {
            $table->id();
            $table->string('name', 255)->index();
            $table->string('description', 1024)->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('items');
    }
};

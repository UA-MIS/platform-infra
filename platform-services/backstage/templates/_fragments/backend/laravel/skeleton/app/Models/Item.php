<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

// Sample model so the CRUD API has something to persist. Replace it with your own
// domain models.
class Item extends Model
{
    protected $fillable = ['name', 'description'];
}

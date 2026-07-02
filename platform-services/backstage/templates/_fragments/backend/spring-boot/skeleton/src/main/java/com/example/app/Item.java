// Item.java — the sample domain model (a Java record = the JSON wire shape AND the row
// shape). Replace it with your own models. `description` is nullable.
package com.example.app;

public record Item(Long id, String name, String description) {}

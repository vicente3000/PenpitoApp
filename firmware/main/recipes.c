#include "recipes.h"

#include <string.h>

static const recipe_t s_recipes[APP_MAX_RECIPES] = {
    {
        .id = "piscola",
        .name = "Piscola",
        .ingredients = {
            { .channel = 0, .ingredient = "Pisco", .amount_ml = 60.0f },
            { .channel = 1, .ingredient = "Cola", .amount_ml = 150.0f },
        },
        .ingredient_count = 2,
        .stir_time_ms = 3000,
        .ice_level = 2,
    },
    {
        .id = "whisky_rocks",
        .name = "Whisky a las Rocas",
        .ingredients = {
            { .channel = 2, .ingredient = "Whisky", .amount_ml = 75.0f },
        },
        .ingredient_count = 1,
        .stir_time_ms = 1500,
        .ice_level = 3,
    },
    {
        .id = "negroni",
        .name = "Negroni",
        .ingredients = {
            { .channel = 0, .ingredient = "Gin", .amount_ml = 30.0f },
            { .channel = 2, .ingredient = "Vermut", .amount_ml = 30.0f },
            { .channel = 3, .ingredient = "Campari", .amount_ml = 30.0f },
        },
        .ingredient_count = 3,
        .stir_time_ms = 3500,
        .ice_level = 2,
    },
    {
        .id = "dry_martini",
        .name = "Dry Martini",
        .ingredients = {
            { .channel = 0, .ingredient = "Gin", .amount_ml = 60.0f },
            { .channel = 2, .ingredient = "Vermut Seco", .amount_ml = 10.0f },
        },
        .ingredient_count = 2,
        .stir_time_ms = 4000,
        .ice_level = 1,
    },
};

const recipe_t *recipes_get_all(size_t *count)
{
    if (count != NULL) {
        *count = APP_MAX_RECIPES;
    }

    return s_recipes;
}

const recipe_t *recipes_find_by_id(const char *recipe_id)
{
    if (recipe_id == NULL) {
        return NULL;
    }

    for (size_t i = 0; i < APP_MAX_RECIPES; ++i) {
        if (strcmp(s_recipes[i].id, recipe_id) == 0) {
            return &s_recipes[i];
        }
    }

    return NULL;
}

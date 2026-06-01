#ifndef RECIPES_H
#define RECIPES_H

#include "app_types.h"

const recipe_t *recipes_get_all(size_t *count);
const recipe_t *recipes_find_by_id(const char *recipe_id);

#endif

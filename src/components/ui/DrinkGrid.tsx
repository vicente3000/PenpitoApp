import React from 'react';
import {
  FlatList,
  Image,
  ImageSourcePropType,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Colors, Shadows } from '../../constants/Colors';
import { Recipe } from '../../models';
import { Card } from './Card';
import { formatCurrency } from '../../utils/drinkConfig';

export interface DrinkGridProps {
  recipes: Recipe[];
  onSelectRecipe: (recipe: Recipe) => void;
  recipeAvailability: (recipe: Recipe) => boolean;
  selectedRecipeId?: string | null;
}

function getDrinkCardImage(recipeId: string): ImageSourcePropType | null {
  switch (recipeId) {
    case 'piscola':
      return require('../../../assets/images/drink-piscola-carousel.png');
    case 'whisky_rocks':
      return require('../../../assets/images/drink-whisky-carousel.png');
    case 'negroni':
      return require('../../../assets/images/drink-negroni-carousel.png');
    case 'gin_tonic':
      return require('../../../assets/images/drink-gin-tonic-carousel.png');
    default:
      return null;
  }
}

export const DrinkGrid = ({
  recipes,
  onSelectRecipe,
  recipeAvailability,
  selectedRecipeId,
}: DrinkGridProps) => {
  const renderItem = ({ item }: { item: Recipe }) => {
    const isAvailable = recipeAvailability(item) && item.is_available;
    const isSelected = selectedRecipeId === item.id;
    const image = getDrinkCardImage(item.id);

    return (
      <Pressable
        style={({ pressed }) => [
          styles.gridItem,
          !isAvailable && styles.disabledItem,
          isSelected && styles.selectedItem,
          pressed && isAvailable && styles.pressedItem,
        ]}
        disabled={!isAvailable}
        onPress={() => onSelectRecipe(item)}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}, ${formatCurrency(item.price)}`}
      >
        <Card style={styles.cardOverrides}>
          {image ? (
            <Image source={image} style={styles.drinkImage} resizeMode="cover" />
          ) : (
            <View style={styles.imagePlaceholder}>
              <Text style={styles.placeholderSymbol}>🍸</Text>
            </View>
          )}

          <View style={styles.infoContainer}>
            <Text style={styles.drinkName} numberOfLines={1}>
              {item.name}
            </Text>
            <View style={styles.metaRow}>
              <Text style={styles.drinkPrice}>{formatCurrency(item.price)}</Text>
              {item.abv !== undefined && (
                <Text style={styles.drinkAbv}>{item.abv}% Vol</Text>
              )}
            </View>
          </View>

          {!isAvailable && (
            <View style={styles.outOfStockBadge}>
              <Text style={styles.outOfStockText}>AGOTADO</Text>
            </View>
          )}

          {isSelected && (
            <View style={styles.selectedIndicator}>
              <Text style={styles.selectedIndicatorText}>✓</Text>
            </View>
          )}
        </Card>
      </Pressable>
    );
  };

  return (
    <FlatList
      data={recipes}
      renderItem={renderItem}
      keyExtractor={(item) => item.id}
      numColumns={2}
      columnWrapperStyle={styles.columnWrapper}
      scrollEnabled={false} // Will scroll inside the main page scroll context
      style={styles.list}
    />
  );
};

const styles = StyleSheet.create({
  list: {
    marginHorizontal: -8,
  },
  columnWrapper: {
    justifyContent: 'space-between',
    paddingHorizontal: 8,
  },
  gridItem: {
    flex: 1,
    marginHorizontal: 6,
    marginBottom: 12,
    maxWidth: '48%',
  },
  cardOverrides: {
    padding: 0,
    marginBottom: 0,
    overflow: 'hidden',
    borderWidth: 1.5,
  },
  pressedItem: {
    opacity: 0.9,
    transform: [{ scale: 0.98 }],
  },
  selectedItem: {
    borderColor: Colors.primary,
    ...Shadows.glowPrimary,
  },
  disabledItem: {
    opacity: 0.45,
  },
  drinkImage: {
    width: '100%',
    height: 120,
    backgroundColor: Colors.surfaceHighlight,
  },
  imagePlaceholder: {
    width: '100%',
    height: 120,
    backgroundColor: Colors.surfaceHighlight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderSymbol: {
    fontSize: 32,
  },
  infoContainer: {
    padding: 12,
  },
  drinkName: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.text,
    marginBottom: 4,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  drinkPrice: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.primary,
  },
  drinkAbv: {
    fontSize: 11,
    color: Colors.textMuted,
    fontWeight: '500',
  },
  outOfStockBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: Colors.error,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  outOfStockText: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  selectedIndicator: {
    position: 'absolute',
    top: 10,
    left: 10,
    backgroundColor: Colors.primary,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadows.glowPrimary,
  },
  selectedIndicatorText: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 12,
  },
});
